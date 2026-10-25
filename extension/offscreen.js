// Plays the alarm. Lives in an offscreen document because service workers can't play audio.
let ctx = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'offscreen' && msg.type === 'siren') siren(msg.seconds || 10);
});

function siren(seconds) {
  ctx = ctx || new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 900;
  lfo.frequency.value = 1.5; // sweeps up and down, like a siren
  lfoGain.gain.value = 350;
  lfo.connect(lfoGain).connect(osc.frequency);
  gain.gain.value = 0.25;
  osc.connect(gain).connect(ctx.destination);
  const end = ctx.currentTime + seconds;
  osc.start();
  lfo.start();
  osc.stop(end);
  lfo.stop(end);
}
