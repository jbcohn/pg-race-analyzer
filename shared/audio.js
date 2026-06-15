// audio.js - Web Audio API sound generators

let audioCtx = null;

export function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume context if suspended (browser autoplay policy)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

export function playCoinSound() {
    if (!audioCtx) initAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;

    const t = audioCtx.currentTime;

    // Mario coin: B5 (987.77 Hz) -> E6 (1318.51 Hz)
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'square'; // 8-bit sound
    
    // Pitch envelope: B5 for 80ms, then E6
    osc.frequency.setValueAtTime(987.77, t);
    osc.frequency.setValueAtTime(1318.51, t + 0.08);

    // Amplitude envelope
    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(0.08, t + 0.01);
    gainNode.gain.setValueAtTime(0.08, t + 0.08);
    gainNode.gain.linearRampToValueAtTime(0.08, t + 0.15);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(t);
    osc.stop(t + 0.5);
}
