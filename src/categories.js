// Curated pool of arXiv categories that reliably see enough new submissions per
// day to fill a puzzle group. Very thin archives (econ.*, nlin.*, q-fin.*,
// hep-lat, nucl-ex, ...) are left out so we don't waste feed fetches on them.
//
// `group` is the top-level archive. The puzzle picks at most one category per
// group, which keeps the four answers conceptually far enough apart to be
// guessable.
//
// Alias pairs (math.IT/cs.IT, math.ST/stat.TH, cs.SY/eess.SY, math.MP/math-ph)
// are represented by exactly one member so the same papers can never appear as
// two different answers.

export const CATEGORIES = [
  ['astro-ph.CO', 'astro-ph', 'Cosmology and Nongalactic Astrophysics'],
  ['astro-ph.EP', 'astro-ph', 'Earth and Planetary Astrophysics'],
  ['astro-ph.GA', 'astro-ph', 'Astrophysics of Galaxies'],
  ['astro-ph.HE', 'astro-ph', 'High Energy Astrophysical Phenomena'],
  ['astro-ph.IM', 'astro-ph', 'Instrumentation and Methods for Astrophysics'],
  ['astro-ph.SR', 'astro-ph', 'Solar and Stellar Astrophysics'],

  ['cond-mat.mes-hall', 'cond-mat', 'Mesoscale and Nanoscale Physics'],
  ['cond-mat.mtrl-sci', 'cond-mat', 'Materials Science'],
  ['cond-mat.quant-gas', 'cond-mat', 'Quantum Gases'],
  ['cond-mat.soft', 'cond-mat', 'Soft Condensed Matter'],
  ['cond-mat.stat-mech', 'cond-mat', 'Statistical Mechanics'],
  ['cond-mat.str-el', 'cond-mat', 'Strongly Correlated Electrons'],
  ['cond-mat.supr-con', 'cond-mat', 'Superconductivity'],

  ['cs.AI', 'cs', 'Artificial Intelligence'],
  ['cs.AR', 'cs', 'Hardware Architecture'],
  ['cs.CC', 'cs', 'Computational Complexity'],
  ['cs.CE', 'cs', 'Computational Engineering, Finance, and Science'],
  ['cs.CL', 'cs', 'Computation and Language'],
  ['cs.CR', 'cs', 'Cryptography and Security'],
  ['cs.CV', 'cs', 'Computer Vision and Pattern Recognition'],
  ['cs.CY', 'cs', 'Computers and Society'],
  ['cs.DB', 'cs', 'Databases'],
  ['cs.DC', 'cs', 'Distributed, Parallel, and Cluster Computing'],
  ['cs.DM', 'cs', 'Discrete Mathematics'],
  ['cs.DS', 'cs', 'Data Structures and Algorithms'],
  ['cs.GT', 'cs', 'Computer Science and Game Theory'],
  ['cs.HC', 'cs', 'Human-Computer Interaction'],
  ['cs.IR', 'cs', 'Information Retrieval'],
  ['cs.IT', 'cs', 'Information Theory'],
  ['cs.LG', 'cs', 'Machine Learning'],
  ['cs.LO', 'cs', 'Logic in Computer Science'],
  ['cs.MA', 'cs', 'Multiagent Systems'],
  ['cs.NE', 'cs', 'Neural and Evolutionary Computing'],
  ['cs.NI', 'cs', 'Networking and Internet Architecture'],
  ['cs.PL', 'cs', 'Programming Languages'],
  ['cs.RO', 'cs', 'Robotics'],
  ['cs.SE', 'cs', 'Software Engineering'],
  ['cs.SI', 'cs', 'Social and Information Networks'],
  ['cs.SD', 'cs', 'Sound'],

  ['eess.AS', 'eess', 'Audio and Speech Processing'],
  ['eess.IV', 'eess', 'Image and Video Processing'],
  ['eess.SP', 'eess', 'Signal Processing'],
  ['eess.SY', 'eess', 'Systems and Control'],

  ['gr-qc', 'gr-qc', 'General Relativity and Quantum Cosmology'],
  ['hep-ex', 'hep-ex', 'High Energy Physics - Experiment'],
  ['hep-ph', 'hep-ph', 'High Energy Physics - Phenomenology'],
  ['hep-th', 'hep-th', 'High Energy Physics - Theory'],
  ['math-ph', 'math-ph', 'Mathematical Physics'],
  ['nucl-th', 'nucl-th', 'Nuclear Theory'],
  ['quant-ph', 'quant-ph', 'Quantum Physics'],

  ['math.AG', 'math', 'Algebraic Geometry'],
  ['math.AP', 'math', 'Analysis of PDEs'],
  ['math.AT', 'math', 'Algebraic Topology'],
  ['math.CA', 'math', 'Classical Analysis and ODEs'],
  ['math.CO', 'math', 'Combinatorics'],
  ['math.CV', 'math', 'Complex Variables'],
  ['math.DG', 'math', 'Differential Geometry'],
  ['math.DS', 'math', 'Dynamical Systems'],
  ['math.FA', 'math', 'Functional Analysis'],
  ['math.GR', 'math', 'Group Theory'],
  ['math.GT', 'math', 'Geometric Topology'],
  ['math.LO', 'math', 'Logic'],
  ['math.MG', 'math', 'Metric Geometry'],
  ['math.NA', 'math', 'Numerical Analysis'],
  ['math.NT', 'math', 'Number Theory'],
  ['math.OC', 'math', 'Optimization and Control'],
  ['math.PR', 'math', 'Probability'],
  ['math.RA', 'math', 'Rings and Algebras'],
  ['math.RT', 'math', 'Representation Theory'],
  ['math.SG', 'math', 'Symplectic Geometry'],

  ['physics.acc-ph', 'physics', 'Accelerator Physics'],
  ['physics.ao-ph', 'physics', 'Atmospheric and Oceanic Physics'],
  ['physics.app-ph', 'physics', 'Applied Physics'],
  ['physics.atom-ph', 'physics', 'Atomic Physics'],
  ['physics.bio-ph', 'physics', 'Biological Physics'],
  ['physics.chem-ph', 'physics', 'Chemical Physics'],
  ['physics.comp-ph', 'physics', 'Computational Physics'],
  ['physics.data-an', 'physics', 'Data Analysis, Statistics and Probability'],
  ['physics.flu-dyn', 'physics', 'Fluid Dynamics'],
  ['physics.geo-ph', 'physics', 'Geophysics'],
  ['physics.ins-det', 'physics', 'Instrumentation and Detectors'],
  ['physics.med-ph', 'physics', 'Medical Physics'],
  ['physics.optics', 'physics', 'Optics'],
  ['physics.plasm-ph', 'physics', 'Plasma Physics'],
  ['physics.soc-ph', 'physics', 'Physics and Society'],
  ['physics.space-ph', 'physics', 'Space Physics'],

  ['q-bio.NC', 'q-bio', 'Neurons and Cognition'],
  ['q-bio.PE', 'q-bio', 'Populations and Evolution'],
  ['q-bio.QM', 'q-bio', 'Quantitative Methods'],

  ['stat.AP', 'stat', 'Applications'],
  ['stat.CO', 'stat', 'Computation'],
  ['stat.ME', 'stat', 'Methodology'],
  ['stat.ML', 'stat', 'Machine Learning'],
  ['stat.TH', 'stat', 'Statistics Theory'],
].map(([id, group, name]) => ({ id, group, name }));

// Pairs that live in different archives but are close enough in practice that
// having both as answers in one puzzle would make it a coin flip.
const CONFLICTS = [
  ['cs.LG', 'stat.ML'], ['cs.AI', 'stat.ML'], ['cs.NE', 'q-bio.NC'],
  ['cs.IT', 'eess.SP'], ['eess.SY', 'math.OC'], ['cs.CV', 'eess.IV'],
  ['cs.SD', 'eess.AS'], ['hep-th', 'math-ph'], ['hep-th', 'gr-qc'],
  ['gr-qc', 'astro-ph.CO'], ['hep-ph', 'hep-ex'], ['hep-ph', 'nucl-th'],
  ['math-ph', 'math.SG'], ['quant-ph', 'cond-mat.quant-gas'],
  ['stat.ME', 'math.PR'], ['stat.TH', 'math.PR'], ['stat.CO', 'math.NA'],
  ['physics.comp-ph', 'math.NA'], ['physics.data-an', 'stat.ME'],
  ['q-bio.QM', 'physics.bio-ph'], ['q-bio.PE', 'physics.soc-ph'],
  ['physics.optics', 'cond-mat.mes-hall'], ['physics.med-ph', 'eess.IV'],
];

const CONFLICT_SET = new Set(CONFLICTS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

/** True if `cat` can join an already-chosen set of categories. */
export function compatible(cat, chosen) {
  return !chosen.some(
    (c) => c.group === cat.group || CONFLICT_SET.has(`${c.id}|${cat.id}`)
  );
}
