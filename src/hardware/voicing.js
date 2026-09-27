// Brand "house sound" voicing curves. Each entry is a list of Web Audio biquad
// specs (peaking Q linear, shelves use S=1) that sits on top of the physical
// enclosure/driver model. They encode well-known tonal reputations, e.g.
// Klipsch horn-loaded treble brightness or SVS's flat, deep bass.

const pk = (frequency, Q, gain) => ({ type: 'peaking', frequency, Q, gain });
const ls = (frequency, gain) => ({ type: 'lowshelf', frequency, gain });
const hs = (frequency, gain) => ({ type: 'highshelf', frequency, gain });

export const SPEAKER_HOUSE_SOUND = {
  Klipsch: { tag: 'Bright & dynamic (horn tweeter)', filters: [pk(350, 1, -1), pk(3200, 1.1, 2.5), hs(8000, 2.5)] },
  KEF: { tag: 'Neutral, precise imaging (Uni-Q)', filters: [pk(2800, 2, 0.8), hs(12000, 0.5)] },
  'Bowers & Wilkins': { tag: 'Detailed, lively upper mids', filters: [pk(180, 1.2, 1), pk(4000, 1.5, 1.2), hs(10000, 1)] },
  'Polk Audio': { tag: 'Warm, easy-going', filters: [ls(150, 1.5), pk(2000, 1.2, -0.8), hs(10000, 0.8)] },
  Sony: { tag: 'Bass-forward with sparkly super tweeter', filters: [pk(100, 1.2, 3), pk(1000, 0.8, -1.5), hs(12000, 2)] },
  Edifier: { tag: 'Warm consumer tuning, punchy mid-bass', filters: [pk(90, 1, 3), pk(1500, 1, -1), hs(10000, -1)] },
  Audioengine: { tag: 'Warm & smooth', filters: [pk(150, 0.9, 1.5), hs(9000, -1)] },
  ELAC: { tag: 'Neutral-warm (Andrew Jones)', filters: [pk(120, 1, 1), pk(3000, 1.2, -0.5)] },
  'Q Acoustics': { tag: 'Warm, relaxed treble', filters: [ls(200, 1), hs(6000, -1.2)] },
  Dali: { tag: 'Warm, sweet wood-fibre midrange', filters: [pk(250, 0.8, 1), pk(3000, 1.5, -1), hs(12000, 0.5)] },
  'Monitor Audio': { tag: 'Bright, open C-CAM treble', filters: [pk(120, 1, 1), hs(7000, 1.8)] },
  Micca: { tag: 'Budget: lumpy mid-bass, cone breakup', filters: [pk(150, 1.5, 2), pk(3500, 3, 2), hs(12000, -2)] },
  Vanatoo: { tag: 'Neutral-bright, DSP-tuned', filters: [pk(60, 1.4, 1.5), hs(8000, 1)] },
  Sonos: { tag: 'DSP loudness contour', filters: [ls(120, 2), hs(10000, 1.5)] },
  PreSonus: { tag: 'Studio flat', filters: [pk(80, 1.2, 0.5)] },
  KRK: { tag: 'Studio with famous bass lift', filters: [ls(100, 2), pk(2500, 2, 0.5)] },
  JBL: { tag: 'Slight smile (HDI waveguide)', filters: [pk(70, 1.2, 1.5), hs(10000, 1.5)] },
  Yamaha: { tag: 'Revealing, forward mids', filters: [pk(2000, 1.2, 1.5), hs(10000, 0.5)] },
  'Adam Audio': { tag: 'Airy ribbon treble', filters: [hs(10000, 1.2), pk(80, 1.5, 0.5)] },
  Neumann: { tag: 'Reference flat', filters: [] },
  Genelec: { tag: 'Reference flat', filters: [] },
  Mackie: { tag: 'Mild bass lift', filters: [pk(100, 1.1, 1.5)] },
  'M-Audio': { tag: 'Bass-lifted desktop tuning', filters: [pk(90, 1.1, 2), hs(9000, 0.5)] },
  'IK Multimedia': { tag: 'DSP-flat micro monitor', filters: [pk(70, 1.4, 1)] },
  Wharfedale: { tag: 'Warm, laid-back British sound', filters: [ls(180, 1.5), hs(5000, -1.5)] },
  Fluance: { tag: 'Big bass, crisp tweeter', filters: [pk(80, 1, 2.5), hs(10000, 1.5)] },
  Pioneer: { tag: 'Neutral (Andrew Jones)', filters: [pk(90, 1, 1), pk(2500, 1.3, -1)] },
  Kanto: { tag: 'Lively consumer V-tilt', filters: [pk(80, 1, 2.5), hs(9000, 1.5)] },
  Bose: { tag: 'Heavily EQ’d bass, scooped mids', filters: [pk(100, 1, 5), pk(1000, 0.8, -2), hs(9000, -1)] },
  'Dayton Audio': { tag: 'Budget, bright AMT/dome', filters: [pk(120, 1.2, 1.5), hs(6000, 2)] },
  Jamo: { tag: 'Warm-bright Scandinavian', filters: [pk(100, 1, 1.5), hs(8000, 1.5)] },
  Triangle: { tag: 'Bright, fast French voicing', filters: [hs(5000, 2), pk(200, 1, -0.5)] },
  'Cambridge Audio': { tag: 'Neutral-bright', filters: [hs(9000, 1)] },
  PSB: { tag: 'Neutral (NRC-measured)', filters: [pk(1000, 0.7, 0.3)] },
  SVS: { tag: 'Neutral with deep extension', filters: [pk(60, 1, 1)] },
  Pyle: { tag: 'Budget: boomy, honky', filters: [pk(150, 2, 3), pk(4000, 2, 3), hs(10000, -4)] },
  Mission: { tag: 'Smooth British', filters: [ls(200, 0.8), hs(8000, -0.5)] },
  Andover: { tag: 'Neutral', filters: [] },
};

export const SUB_HOUSE_SOUND = {
  SVS: { tag: 'Flat, deep, articulate', filters: [pk(25, 1.2, 1)] },
  Klipsch: { tag: 'Boomy port-tuned punch', filters: [pk(45, 2, 3), pk(70, 1.5, 1.5)] },
  'Polk Audio': { tag: 'One-note mid-bass bloom', filters: [pk(50, 1.8, 2.5)] },
  Monoprice: { tag: 'Boomy budget', filters: [pk(55, 2, 3)] },
  Monolith: { tag: 'THX-certified, flat & deep', filters: [pk(25, 1, 1)] },
  Sonos: { tag: 'DSP-equalised loudness', filters: [pk(40, 1.2, 2)] },
  KEF: { tag: 'Flat, sealed precision (Music Integrity Engine)', filters: [] },
  RSL: { tag: 'Tight and flat', filters: [pk(30, 1.2, 1)] },
  Sony: { tag: 'Boomy home-theatre tuning', filters: [pk(60, 1.6, 3)] },
  ELAC: { tag: 'Moderate warmth', filters: [pk(40, 1.4, 1.5)] },
  Audioengine: { tag: 'Punchy compact', filters: [pk(45, 1.4, 2)] },
  Pyle: { tag: 'Boomy, limited extension', filters: [pk(60, 2, 4)] },
  Bose: { tag: 'DSP-limited, mid-bass heavy', filters: [pk(60, 1.4, 3)] },
  'Dayton Audio': { tag: 'Value, mild boom', filters: [pk(40, 1.5, 2)] },
  'BIC America': { tag: 'Deep for the money', filters: [pk(30, 1.4, 2)] },
  REL: { tag: 'Fast, tight, musical', filters: [pk(35, 1.2, 0.5)] },
  JBL: { tag: 'Punchy', filters: [pk(50, 1.5, 2)] },
  Yamaha: { tag: 'Advanced YST punch', filters: [pk(60, 1.5, 2.5)] },
  Fluance: { tag: 'Warm and big', filters: [pk(45, 1.5, 2)] },
  Rockville: { tag: 'Boomy budget', filters: [pk(55, 2, 3)] },
  'Martin Logan': { tag: 'Flat with PBK room correction', filters: [] },
  'Definitive Technology': { tag: 'Punchy (passive radiators)', filters: [pk(40, 1.5, 1.5)] },
  Paradigm: { tag: 'Flat, ARC-ready', filters: [] },
  'Hsu Research': { tag: 'Deep, flat, high output', filters: [pk(22, 1.2, 1)] },
  Rythmik: { tag: 'Servo-controlled, ultra-low distortion', filters: [] },
  Velodyne: { tag: 'Punchy classic', filters: [pk(50, 1.5, 1.5)] },
  'Monitor Audio': { tag: 'Musical', filters: [pk(45, 1.4, 1)] },
  'Q Acoustics': { tag: 'Warm', filters: [pk(50, 1.4, 1.5)] },
  Dali: { tag: 'Musical, warm', filters: [pk(45, 1.4, 1)] },
  Wharfedale: { tag: 'Warm', filters: [pk(45, 1.5, 1.5)] },
  Edifier: { tag: 'Mid-bass punch', filters: [pk(60, 1.6, 2.5)] },
  Kanto: { tag: 'Compact punch', filters: [pk(55, 1.5, 2)] },
  PreSonus: { tag: 'Studio flat', filters: [] },
  KRK: { tag: 'Studio, slight lift', filters: [pk(45, 1.4, 1)] },
  Mackie: { tag: 'Desktop punch', filters: [pk(55, 1.5, 2)] },
  'M-Audio': { tag: 'Punchy', filters: [pk(50, 1.5, 2)] },
  'JL Audio': { tag: 'Reference, very low distortion', filters: [] },
  Emotiva: { tag: 'Flat, value', filters: [pk(30, 1.2, 1)] },
  'Cerwin-Vega': { tag: 'Loud & proud', filters: [pk(50, 1.6, 3)] },
};

export const DEFAULT_SPEAKER_VOICING = { tag: 'Neutral', filters: [] };
export const DEFAULT_SUB_VOICING = { tag: 'Neutral', filters: [pk(45, 1.4, 1)] };

/** Off-axis high-frequency loss (dB at 90°) by tweeter type — narrower horns beam more. */
export const DIRECTIVITY_DB = { dome: 8, horn: 12, amt: 10, ribbon: 11, coax: 7, none: 14 };

/** Approximate directivity factor Q (mid-band) for reverberant-field feeding. */
export const DIRECTIVITY_Q = { dome: 2.2, horn: 4, amt: 2.8, ribbon: 3, coax: 2.4, none: 1.8 };
