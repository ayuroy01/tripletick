export interface Peer { pc: RTCPeerConnection; close: () => void; setMuted: (m: boolean) => void }

/** Opens the microphone and wires the other side's audio to the speakers. */
export async function createPeer(iceServers: RTCIceServer[]): Promise<Peer> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calling needs a secure connection (https or localhost)');
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
    throw new Error('Allow microphone access to make calls');
  });
  const pc = new RTCPeerConnection({ iceServers });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  const speaker = new Audio();
  speaker.autoplay = true;
  pc.ontrack = (e) => { speaker.srcObject = e.streams[0]; speaker.play().catch(() => {}); };
  return {
    pc,
    setMuted: (m) => mic.getAudioTracks().forEach((t) => { t.enabled = !m; }),
    close: () => {
      mic.getTracks().forEach((t) => t.stop());
      speaker.srcObject = null;
      pc.close();
    },
  };
}

/** WhatsApp takes one complete SDP, so every network candidate has to be in it before it's sent. */
export function finishGathering(pc: RTCPeerConnection, timeoutMs = 3000) {
  return new Promise<void>((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
    });
  });
}

export const connect = (peer: Peer, type: 'offer' | 'answer', sdp: string) => peer.pc.setRemoteDescription({ type, sdp });

/** Any page can start a call. The dock owns the connection. */
export const dial = (conversationId: number) => dispatchEvent(new CustomEvent('tt-dial', { detail: conversationId }));
