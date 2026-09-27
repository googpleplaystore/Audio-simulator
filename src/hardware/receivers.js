// AV receiver / amplifier presets. Power ratings are per channel into 8 Ω at
// realistic (low-THD) ratings; `ampClass` selects the clipping character.

export const RECEIVERS = [
  { id: 'denon-avr-s760h', name: 'Denon AVR-S760H', watts: 75, ampClass: 'ab', kind: 'AV receiver' },
  { id: 'yamaha-rx-v6a', name: 'Yamaha RX-V6A', watts: 100, ampClass: 'ab', kind: 'AV receiver' },
  { id: 'onkyo-tx-sr393', name: 'Onkyo TX-SR393', watts: 80, ampClass: 'ab', kind: 'AV receiver' },
  { id: 'marantz-nr1711', name: 'Marantz NR1711 (Slimline)', watts: 50, ampClass: 'ab', kind: 'AV receiver' },
  { id: 'sony-str-dh190', name: 'Sony STR-DH190 (Stereo)', watts: 60, ampClass: 'ab', kind: 'Stereo receiver' },
  { id: 'fosi-bt20a', name: 'Fosi Audio BT20A (TPA3251)', watts: 70, ampClass: 'd', kind: 'Class-D mini amp' },
  { id: 'lepai-lp2020', name: 'Lepai LP-2020A+ T-Amp', watts: 10, ampClass: 'd', kind: 'Class-T mini amp' },
  { id: 'crown-xls1002', name: 'Crown XLS 1002 (Pro)', watts: 215, ampClass: 'd', kind: 'Pro power amp' },
  { id: 'marantz-2270', name: 'Marantz 2270 (1971 Vintage)', watts: 70, ampClass: 'ab', kind: 'Vintage receiver' },
  { id: 'tube-el34-se', name: 'Single-Ended EL34 Tube Amp', watts: 8, ampClass: 'tube', kind: 'Tube integrated' },
  { id: 'tube-kt88-pp', name: 'KT88 Push-Pull Tube Amp', watts: 45, ampClass: 'tube', kind: 'Tube integrated' },
  { id: 'monoblock-500', name: 'Reference Monoblocks', watts: 500, ampClass: 'ab', kind: 'Power amp' },
];

export function getReceiver(id) {
  return RECEIVERS.find((r) => r.id === id) || null;
}

export const AMP_CLASSES = {
  ab: { name: 'Class AB (solid-state)', knee: 0.8 },
  d: { name: 'Class D (switching)', knee: 0.94 },
  tube: { name: 'Vacuum tube', knee: 0 },
};
