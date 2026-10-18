// WebRTC Service for Web Platform
// Uses native browser WebRTC APIs: RTCPeerConnection, navigator.mediaDevices

const peerConnectionConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

class WebRTCServiceWeb {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this._isMuted = false;
    this._isSpeakerOn = true;
    this.iceCandidatesQueue = [];
    this.remoteAudioElement = null;
  }

  getRTCPeerConnectionClass() {
    if (typeof window !== 'undefined') {
      return window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    }
    return null;
  }

  getRTCIceCandidateClass() {
    if (typeof window !== 'undefined') {
      return window.RTCIceCandidate || window.webkitRTCIceCandidate;
    }
    return null;
  }

  getRTCSessionDescriptionClass() {
    if (typeof window !== 'undefined') {
      return window.RTCSessionDescription || window.webkitRTCSessionDescription;
    }
    return null;
  }

  // Initialize WebRTC and capture local audio stream from microphone
  async initializeAudio() {
    try {
      console.log('[WEBRTC-WEB] Initializing audio in browser...');

      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported in this browser.');
      }

      // Stop existing local stream if any
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => track.stop());
        this.localStream = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.localStream = stream;
      this._isMuted = false;

      console.log('[WEBRTC-WEB] Local audio stream obtained successfully');
      return stream;
    } catch (error) {
      console.error('[WEBRTC-WEB] Error initializing audio:', error);
      throw error;
    }
  }

  // Create RTCPeerConnection in web browser
  async createPeerConnection(onRemoteStreamReady, onIceCandidate) {
    try {
      console.log('[WEBRTC-WEB] Creating browser peer connection...');
      const PeerConnectionClass = this.getRTCPeerConnectionClass();

      if (!PeerConnectionClass) {
        throw new Error('RTCPeerConnection is not supported in this browser.');
      }

      this.peerConnection = new PeerConnectionClass(peerConnectionConfig);

      // Add local audio tracks to peer connection
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          console.log('[WEBRTC-WEB] Adding local track to peer connection:', track.kind);
          this.peerConnection.addTrack(track, this.localStream);
        });
      }

      // Handle ICE candidates from browser
      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('[WEBRTC-WEB] ICE candidate generated:', event.candidate.candidate);
          if (onIceCandidate) {
            onIceCandidate(event.candidate);
          }
        }
      };

      // Handle incoming remote track
      this.peerConnection.ontrack = (event) => {
        console.log('[WEBRTC-WEB] Received remote track:', event.track.kind);
        if (event.streams && event.streams[0]) {
          this.remoteStream = event.streams[0];
          this.attachRemoteAudio(this.remoteStream);

          if (onRemoteStreamReady) {
            onRemoteStreamReady(this.remoteStream);
          }
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        console.log('[WEBRTC-WEB] Connection state:', this.peerConnection.connectionState);
      };

      this.peerConnection.oniceconnectionstatechange = () => {
        console.log('[WEBRTC-WEB] ICE connection state:', this.peerConnection.iceConnectionState);
      };

      console.log('[WEBRTC-WEB] Peer connection created successfully');
      return this.peerConnection;
    } catch (error) {
      console.error('[WEBRTC-WEB] Error creating peer connection:', error);
      throw error;
    }
  }

  // Attach remote stream to hidden HTML audio element to play sound
  attachRemoteAudio(stream) {
    if (typeof document === 'undefined') return;

    try {
      if (!this.remoteAudioElement) {
        let el = document.getElementById('saarthi-remote-audio');
        if (!el) {
          el = document.createElement('audio');
          el.id = 'saarthi-remote-audio';
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
        }
        this.remoteAudioElement = el;
      }

      this.remoteAudioElement.srcObject = stream;
      this.remoteAudioElement.play().catch((err) => {
        console.log('[WEBRTC-WEB] Auto-play prevented or waiting for user interaction:', err);
      });
    } catch (e) {
      console.warn('[WEBRTC-WEB] Error attaching remote audio:', e);
    }
  }

  // Create WebRTC Offer
  async createOffer() {
    try {
      if (!this.peerConnection) {
        throw new Error('Peer connection not initialized');
      }

      console.log('[WEBRTC-WEB] Creating offer...');
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      await this.peerConnection.setLocalDescription(offer);
      console.log('[WEBRTC-WEB] Offer created and set as local description');
      return offer;
    } catch (error) {
      console.error('[WEBRTC-WEB] Error creating offer:', error);
      throw error;
    }
  }

  async processQueuedIceCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;

    const CandidateClass = this.getRTCIceCandidateClass();
    while (this.iceCandidatesQueue.length > 0) {
      const candidate = this.iceCandidatesQueue.shift();
      try {
        await this.peerConnection.addIceCandidate(
          CandidateClass ? new CandidateClass(candidate) : candidate
        );
      } catch (error) {
        console.error('[WEBRTC-WEB] Error adding queued ICE candidate:', error);
      }
    }
  }

  // Create WebRTC Answer
  async createAnswer(offer) {
    try {
      if (!this.peerConnection) {
        throw new Error('Peer connection not initialized');
      }

      console.log('[WEBRTC-WEB] Creating answer...');
      const SessionDescClass = this.getRTCSessionDescriptionClass();
      await this.peerConnection.setRemoteDescription(
        SessionDescClass ? new SessionDescClass(offer) : offer
      );

      await this.processQueuedIceCandidates();

      const answer = await this.peerConnection.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      await this.peerConnection.setLocalDescription(answer);
      console.log('[WEBRTC-WEB] Answer created and set as local description');
      return answer;
    } catch (error) {
      console.error('[WEBRTC-WEB] Error creating answer:', error);
      throw error;
    }
  }

  // Handle Answer
  async handleAnswer(answer) {
    try {
      if (!this.peerConnection) {
        throw new Error('Peer connection not initialized');
      }

      console.log('[WEBRTC-WEB] Handling remote answer...');
      const SessionDescClass = this.getRTCSessionDescriptionClass();
      await this.peerConnection.setRemoteDescription(
        SessionDescClass ? new SessionDescClass(answer) : answer
      );

      await this.processQueuedIceCandidates();
      console.log('[WEBRTC-WEB] Remote description set successfully');
    } catch (error) {
      console.error('[WEBRTC-WEB] Error handling answer:', error);
      throw error;
    }
  }

  // Add ICE Candidate
  async addIceCandidate(candidate) {
    try {
      if (!this.peerConnection) {
        throw new Error('Peer connection not initialized');
      }

      if (candidate) {
        if (this.peerConnection.remoteDescription) {
          const CandidateClass = this.getRTCIceCandidateClass();
          await this.peerConnection.addIceCandidate(
            CandidateClass ? new CandidateClass(candidate) : candidate
          );
        } else {
          this.iceCandidatesQueue.push(candidate);
        }
      }
    } catch (error) {
      console.error('[WEBRTC-WEB] Error adding ICE candidate:', error);
    }
  }

  toggleMute() {
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = this._isMuted;
      });
      this._isMuted = !this._isMuted;
      console.log('[WEBRTC-WEB] Mute toggled:', this._isMuted ? 'ON' : 'OFF');
      return this._isMuted;
    }
    return false;
  }

  async toggleSpeaker() {
    this._isSpeakerOn = !this._isSpeakerOn;
    console.log('[WEBRTC-WEB] Speaker toggled:', this._isSpeakerOn ? 'ON' : 'OFF');
    return this._isSpeakerOn;
  }

  isMuted() {
    return this._isMuted;
  }

  isSpeakerOn() {
    return this._isSpeakerOn;
  }

  closeConnection() {
    try {
      console.log('[WEBRTC-WEB] Closing connection...');

      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => track.stop());
        this.localStream = null;
      }

      if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
      }

      if (this.remoteAudioElement) {
        this.remoteAudioElement.srcObject = null;
      }

      this.remoteStream = null;
      this._isMuted = false;
      this.iceCandidatesQueue = [];

      console.log('[WEBRTC-WEB] Connection closed cleanly');
    } catch (error) {
      console.error('[WEBRTC-WEB] Error closing connection:', error);
    }
  }

  getConnectionState() {
    return this.peerConnection ? this.peerConnection.connectionState : null;
  }

  getIceConnectionState() {
    return this.peerConnection ? this.peerConnection.iceConnectionState : null;
  }
}

export default new WebRTCServiceWeb();
