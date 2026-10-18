import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || 'saathicircle';

let client = null;
if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 2000,
  });
}

let clientPromise = null;
let dbInstance = null;
let useFallback = false;
let fallbackDb = {};
const fallbackFile = path.resolve('db-fallback.json');

const loadFallback = () => {
  try {
    if (fs.existsSync(fallbackFile)) {
      fallbackDb = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load fallback DB:', e.message);
  }
};

const saveFallback = () => {
  fs.writeFile(fallbackFile, JSON.stringify(fallbackDb), 'utf8', (err) => {
    if (err) {
      console.error('Failed to save fallback DB:', err.message);
    }
  });
};

const mockDb = {
  collection: (name) => ({
    createIndex: async () => ({}),
    countDocuments: async (filter) => count(name, filter),
    findOne: async (filter, options) => findOne(name, filter, options),
    find: (filter, options) => {
      let cursor = {
        sort: () => cursor,
        limit: () => cursor,
        toArray: async () => findMany(name, filter, options),
      };
      return cursor;
    },
    insertOne: async (doc) => insertOne(name, doc),
    findOneAndUpdate: async (filter, update, options) => {
      const payload = update.$set || update;
      const res = await upsertOne(name, filter, payload, options);
      return { value: res };
    },
    deleteOne: async (filter) => deleteOne(name, filter),
    deleteMany: async (filter) => deleteMany(name, filter),
  }),
};

export const connectMongo = async () => {
  if (useFallback) return mockDb;
  if (!uri) {
    console.warn('\n[WARNING] MONGODB_URI or MONGO_URI environment variable is missing.');
    console.warn('[INFO] Falling back to local JSON database (db-fallback.json) for runtime storage.\n');
    useFallback = true;
    loadFallback();
    return mockDb;
  }
  try {
    if (!clientPromise) {
      clientPromise = client.connect();
    }
    if (!dbInstance) {
      await clientPromise;
      dbInstance = client.db(dbName);
    }
    return dbInstance;
  } catch (err) {
    console.warn('\n[WARNING] Failed to connect to MongoDB server:', err.message);
    console.warn('[INFO] Falling back to local JSON database (db-fallback.json) to keep app running.\n');
    useFallback = true;
    loadFallback();
    return mockDb;
  }
};

const normalizeDoc = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;
  const next = { ...doc };
  if (next.id && next._id === undefined) next._id = next.id;
  if (!next.id && next._id !== undefined) next.id = String(next._id);
  return next;
};

const collection = async (name) => {
  const db = await connectMongo();
  return db ? db.collection(name) : null;
};

const getCollectionDocs = (name) => {
  if (!fallbackDb[name]) fallbackDb[name] = [];
  return fallbackDb[name];
};

const matchesFilter = (doc, filter) => {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const key in filter) {
    if (key === '$or') {
      const clauses = filter[key];
      const anyMatch = clauses.some(clause => matchesFilter(doc, clause));
      if (!anyMatch) return false;
      continue;
    }
    const val = filter[key];
    if (val && typeof val === 'object' && val.$in) {
      const list = Array.isArray(val.$in) ? val.$in : [val.$in];
      if (!list.includes(doc[key])) return false;
    } else if (val && typeof val === 'object' && val.$ne !== undefined) {
      if (doc[key] === val.$ne) return false;
    } else {
      if (doc[key] !== val) return false;
    }
  }
  return true;
};

export const findOne = async (collectionName, filter = {}, options = {}) => {
  await connectMongo();
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    const doc = docs.find(d => matchesFilter(d, filter));
    return doc ? normalizeDoc(doc) : null;
  }
  const col = await collection(collectionName);
  const doc = await col.findOne(filter, options);
  return doc ? normalizeDoc(doc) : null;
};

export const findMany = async (collectionName, filter = {}, options = {}) => {
  await connectMongo();
  if (useFallback) {
    let docs = getCollectionDocs(collectionName).filter(d => matchesFilter(d, filter));
    if (options.sort) {
      const sortKey = Object.keys(options.sort)[0];
      const sortDir = options.sort[sortKey];
      docs.sort((a, b) => {
        if (a[sortKey] < b[sortKey]) return -sortDir;
        if (a[sortKey] > b[sortKey]) return sortDir;
        return 0;
      });
    }
    if (options.limit) {
      docs = docs.slice(0, options.limit);
    }
    return docs.map(normalizeDoc);
  }
  const col = await collection(collectionName);
  const cursor = col.find(filter, options);
  if (options.sort) cursor.sort(options.sort);
  if (options.limit) cursor.limit(options.limit);
  const docs = await cursor.toArray();
  return docs.map(normalizeDoc);
};

export const count = async (collectionName, filter = {}) => {
  await connectMongo();
  if (useFallback) {
    return getCollectionDocs(collectionName).filter(d => matchesFilter(d, filter)).length;
  }
  const col = await collection(collectionName);
  return col.countDocuments(filter);
};

export const insertOne = async (collectionName, doc) => {
  await connectMongo();
  const next = normalizeDoc(doc);
  if (!next.id) {
    next.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
  }
  next._id = next.id;
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    docs.push(next);
    saveFallback();
    return next;
  }
  const col = await collection(collectionName);
  await col.insertOne(next);
  return next;
};

export const upsertOne = async (collectionName, filter, update, options = {}) => {
  await connectMongo();
  const next = normalizeDoc(update);
  if (next.id) next._id = next.id;
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    let idx = docs.findIndex(d => matchesFilter(d, filter));
    if (idx !== -1) {
      docs[idx] = { ...docs[idx], ...next };
      saveFallback();
      return normalizeDoc(docs[idx]);
    } else {
      if (!next.id) {
        next.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
        next._id = next.id;
      }
      docs.push(next);
      saveFallback();
      return next;
    }
  }
  const col = await collection(collectionName);
  const result = await col.findOneAndUpdate(
    filter,
    { $set: next },
    { upsert: true, returnDocument: 'after', ...options }
  );
  const resDoc = result && result.value !== undefined ? result.value : result;
  return resDoc ? normalizeDoc(resDoc) : null;
};

export const updateOne = async (collectionName, filter, update, options = {}) => {
  await connectMongo();
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    let idx = docs.findIndex(d => matchesFilter(d, filter));
    if (idx !== -1) {
      docs[idx] = { ...docs[idx], ...update };
      saveFallback();
      return normalizeDoc(docs[idx]);
    }
    return null;
  }
  const col = await collection(collectionName);
  const result = await col.findOneAndUpdate(
    filter,
    { $set: update },
    { returnDocument: 'after', ...options }
  );
  const resDoc = result && result.value !== undefined ? result.value : result;
  return resDoc ? normalizeDoc(resDoc) : null;
};

export const deleteOne = async (collectionName, filter) => {
  await connectMongo();
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    let idx = docs.findIndex(d => matchesFilter(d, filter));
    if (idx !== -1) {
      docs.splice(idx, 1);
      saveFallback();
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
  const col = await collection(collectionName);
  return col.deleteOne(filter);
};

export const deleteMany = async (collectionName, filter) => {
  await connectMongo();
  if (useFallback) {
    const docs = getCollectionDocs(collectionName);
    const initialLength = docs.length;
    const remaining = docs.filter(d => !matchesFilter(d, filter));
    fallbackDb[collectionName] = remaining;
    saveFallback();
    return { deletedCount: initialLength - remaining.length };
  }
  const col = await collection(collectionName);
  return col.deleteMany(filter);
};

const coerceValue = (raw) => {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!Number.isNaN(num) && String(num) === raw) return num;
  return raw;
};

class MongoQuery {
  constructor(table) {
    this.table = table;
    this.filter = {};
    this.projection = null;
    this.sort = null;
    this.limitValue = null;
    this.singleResult = false;
    this.maybe = false;
    this.countMode = false;
    this.head = false;
    this.insertPayload = null;
    this.updatePayload = null;
    this.upsertPayload = null;
    this.upsertOptions = {};
    this.deleteOp = false;
  }

  select(columns = '*', opts = {}) {
    if (columns && columns !== '*') {
      const fields = String(columns).split(',').map((f) => f.trim()).filter(Boolean);
      this.projection = fields.reduce((acc, field) => {
        acc[field] = 1;
        return acc;
      }, {});
    }
    if (opts && opts.count === 'exact') this.countMode = true;
    if (opts && opts.head === true) this.head = true;
    return this;
  }

  insert(payload) {
    this.insertPayload = payload;
    return this;
  }

  update(payload) {
    this.updatePayload = payload;
    return this;
  }

  upsert(payload, opts = {}) {
    this.upsertPayload = payload;
    this.upsertOptions = opts;
    return this;
  }

  delete() {
    this.deleteOp = true;
    return this;
  }

  eq(field, value) {
    this.filter[field] = value;
    return this;
  }

  in(field, values) {
    this.filter[field] = { $in: Array.isArray(values) ? values : [values] };
    return this;
  }

  is(field, value) {
    if (value === null) {
      this.filter[field] = null;
    } else {
      this.filter[field] = value;
    }
    return this;
  }

  not(field, op, value) {
    if (op === 'is' && value === null) {
      this.filter[field] = { $ne: null };
    } else {
      this.filter[field] = { $ne: value };
    }
    return this;
  }

  or(expression) {
    if (!expression) return this;
    const clauses = String(expression)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [field, operator, rawValue] = part.split('.');
        if (operator === 'eq') {
          return { [field]: coerceValue(rawValue) };
        }
        return {};
      })
      .filter((clause) => Object.keys(clause).length > 0);
    if (clauses.length) {
      this.filter.$or = clauses;
    }
    return this;
  }

  order(field, opts = {}) {
    if (!field) return this;
    this.sort = { [field]: opts.ascending === false ? -1 : 1 };
    return this;
  }

  limit(value) {
    this.limitValue = Number(value) || 0;
    return this;
  }

  single() {
    this.singleResult = true;
    return this;
  }

  maybeSingle() {
    this.singleResult = true;
    this.maybe = true;
    return this;
  }

  async execute() {
    await connectMongo();

    if (useFallback) {
      const docs = getCollectionDocs(this.table);

      if (this.insertPayload) {
        const next = normalizeDoc(this.insertPayload);
        if (!next.id) {
          next.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
        }
        next._id = next.id;
        docs.push(next);
        saveFallback();
        return { data: this.singleResult ? next : [next], error: null };
      }

      if (this.deleteOp) {
        const initialLength = docs.length;
        const remaining = docs.filter(d => !matchesFilter(d, this.filter));
        fallbackDb[this.table] = remaining;
        saveFallback();
        return { data: [], error: null };
      }

      if (this.upsertPayload) {
        let filter = { ...this.filter };
        if (!Object.keys(filter).length) {
          const key = this.upsertOptions.onConflict;
          if (key && this.upsertPayload[key] !== undefined) {
            filter[key] = this.upsertPayload[key];
          } else if (this.upsertPayload.id !== undefined) {
            filter.id = this.upsertPayload.id;
          }
        }
        const next = normalizeDoc(this.upsertPayload);
        if (next.id) next._id = next.id;
        let idx = docs.findIndex(d => matchesFilter(d, filter));
        let data;
        if (idx !== -1) {
          docs[idx] = { ...docs[idx], ...next };
          data = docs[idx];
        } else {
          if (!next.id) {
            next.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
            next._id = next.id;
          }
          docs.push(next);
          data = next;
        }
        saveFallback();
        return { data: this.singleResult ? data : [data], error: null };
      }

      if (this.updatePayload) {
        let updatedCount = 0;
        let lastDoc = null;
        for (let i = 0; i < docs.length; i++) {
          if (matchesFilter(docs[i], this.filter)) {
            docs[i] = { ...docs[i], ...this.updatePayload };
            lastDoc = docs[i];
            updatedCount++;
          }
        }
        if (updatedCount > 0) saveFallback();
        return { data: this.singleResult ? lastDoc : (lastDoc ? [lastDoc] : []), error: null };
      }

      if (this.countMode) {
        const countValue = docs.filter(d => matchesFilter(d, this.filter)).length;
        return { data: [], count: countValue, error: null };
      }

      let filtered = docs.filter(d => matchesFilter(d, this.filter));
      if (this.sort) {
        const sortKey = Object.keys(this.sort)[0];
        const sortDir = this.sort[sortKey];
        filtered.sort((a, b) => {
          if (a[sortKey] < b[sortKey]) return -sortDir;
          if (a[sortKey] > b[sortKey]) return sortDir;
          return 0;
        });
      }
      if (this.limitValue) {
        filtered = filtered.slice(0, this.limitValue);
      }
      const data = this.singleResult ? filtered[0] ?? null : filtered;
      const error = this.singleResult && !this.maybe && data == null ? { code: 'PGRST116', message: 'No rows found' } : null;
      return { data, error };
    }

    const col = await collection(this.table);

    if (this.insertPayload) {
      const next = normalizeDoc(this.insertPayload);
      if (!next.id) {
        next.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
      }
      next._id = next.id;
      await col.insertOne(next);
      return { data: this.singleResult ? next : [next], error: null };
    }

    if (this.deleteOp) {
      await col.deleteMany(this.filter);
      return { data: [], error: null };
    }

    if (this.upsertPayload) {
      let filter = { ...this.filter };
      if (!Object.keys(filter).length) {
        const key = this.upsertOptions.onConflict;
        if (key && this.upsertPayload[key] !== undefined) {
          filter[key] = this.upsertPayload[key];
        } else if (this.upsertPayload.id !== undefined) {
          filter.id = this.upsertPayload.id;
        }
      }
      const next = normalizeDoc(this.upsertPayload);
      if (next.id) next._id = next.id;
      const result = await col.findOneAndUpdate(filter, { $set: next }, { upsert: true, returnDocument: 'after' });
      const resDoc = result && result.value !== undefined ? result.value : result;
      const data = resDoc ? normalizeDoc(resDoc) : null;
      return { data: this.singleResult ? data : [data], error: null };
    }

    if (this.updatePayload) {
      const result = await col.findOneAndUpdate(this.filter, { $set: this.updatePayload }, { returnDocument: 'after' });
      const resDoc = result && result.value !== undefined ? result.value : result;
      const data = resDoc ? normalizeDoc(resDoc) : null;
      return { data: this.singleResult ? data : [data], error: null };
    }

    if (this.countMode) {
      const countValue = await col.countDocuments(this.filter);
      return { data: [], count: countValue, error: null };
    }

    let cursor = col.find(this.filter, this.projection ? { projection: this.projection } : {});
    if (this.sort) cursor.sort(this.sort);
    if (this.limitValue) cursor.limit(this.limitValue);
    const docs = await cursor.toArray();
    const normalized = docs.map(normalizeDoc);
    const data = this.singleResult ? normalized[0] ?? null : normalized;
    const error = this.singleResult && !this.maybe && data == null ? { code: 'PGRST116', message: 'No rows found' } : null;
    return { data, error };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

export const supabase = {
  from: (table) => new MongoQuery(table),
  auth: {
    getUser: async () => ({ data: null, error: { message: 'Mongo auth unsupported' } }),
  },
};

export const closeMongo = async () => {
  if (client) {
    await client.close();
    dbInstance = null;
    clientPromise = null;
  }
};
