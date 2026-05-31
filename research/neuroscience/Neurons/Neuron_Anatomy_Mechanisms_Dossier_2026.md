# Neuron Anatomy & Mechanisms Dossier

*A reverse-engineering reference for computational/biophysical architecture design.*

---

## 1. Core Anatomical Structures

### 1.1 Soma (Cell Body)

The soma is the metabolic and genetic command center — the neuron's CPU core with its own power supply and instruction set.

- **Nucleus**: Houses ~6 pg of DNA; transcriptionally active zones produce mRNA sorted by *axonal* vs. *dendritic* destination via distinct zip-code sequences in 3′ UTRs. The nucleus is not a passive archive — immediate-early genes (IEGs) like *c-fos* and *Arc* are transcribed within 5–30 minutes of synaptic activity, converting transient calcium signals into long-term structural change.
- **Nucleolus**: Ribosomal RNA factory; neurons maintain ~10⁶ ribosomes to sustain the extreme protein demand of synaptic maintenance.
- **Rough ER (Nissl substance)**: Stacked cisternae studded with ribosomes — the soma's protein synthesis line. Produces transmembrane proteins, secretory vesicles, and cytoskeletal subunits. Chromatolysis (dissolution) is a hallmark of axonal injury response.
- **Golgi apparatus**: Sorting and post-translational modification hub. Glycosylation, phosphorylation, and vesicle packaging occur here. Vesicles are tagged with SNARE-components and motor-adaptor complexes before dispatching to axon or dendrites.
- **Mitochondria**: Neurons contain thousands — up to 2 million per cell. They undergo fission, fusion, and motile trafficking along microtubules via Miro/Milton adaptors on kinesin-1. Mitochondria park at nodes of Ranvier, synaptic boutons, and active growth cones — wherever ATP demand spikes. They also buffer Ca²⁺ and generate ROS as signaling molecules.

**Computational analogy**: The soma is a factory with on-demand production (activity-dependent transcription), just-in-time logistics (mRNA sorting, vesicle trafficking), and distributed power substations (motile mitochondria).

### 1.2 Axon

The axon is a specialized transmission cable — a biological coaxial conductor optimized for faithful, high-speed, long-range signal propagation.

- **Axon hillock**: The decision gate. Located at the soma–axon junction, it has the *lowest firing threshold* in the neuron due to an exceptionally high density of voltage-gated Na⁺ channels (~350/µm² vs. ~50/µm² in the soma). This is where graded postsynaptic potentials are integrated and, if suprathreshold, converted to an all-or-nothing action potential — a comparator with a configurable threshold.
- **Initial segment (AIS)**: ~30–60 µm long, bounded proximally by the axon hillock and distally by the start of myelin. Contains a dense lattice of Na⁺ channel clusters (primarily Nav1.6) anchored by ankyrin-G and βIV-spectrin. The AIS is *plastic*: activity can shift its position or change channel density, retuning the neuron's excitability on hours-to-days timescales.
- **Axon proper**: A slender cylinder (0.2–20 µm diameter) filled with a parallel array of microtubules (uniform plus-end-out polarity), neurofilaments, and actin cortex. Contains no rough ER or ribosomes — entirely dependent on soma-derived supply and local translation from transported mRNA.
- **Nodes of Ranvier**: ~1–2 µm gaps in myelin sheath, repeating every ~0.2–2 mm. Each node contains ~1,000–2,000 Nav1.6 channels/µm² — the highest density in the nervous system. The node is where action potentials are *regenerated*, enabling saltatory conduction. Paranodal regions contain Caspr/paranodin complexes that anchor myelin loops and restrict lateral diffusion of channels.
- **Axon terminals (boutons)**: Swellings containing synaptic vesicle pools, active zones, mitochondria, and presynaptic machinery. A single axon may branch into thousands of boutons. Each bouton is a semi-autonomous release module.

**Computational analogy**: The axon is a repeater chain (nodes = repeater stations) with a launch codec (AIS/hillock) and distributed output ports (boutons). The decision to fire is binary at the hillock; propagation is lossless due to active regeneration.

### 1.3 Dendrites

Dendrites are the input antenna array — a fractal arboreal structure that captures, weights, and integrates signals from thousands of synapses.

- **Dendritic arbor**: Typically 10–30 primary dendrites branch into a tree spanning hundreds of micrometers. Pyramidal neurons have ~10⁴ dendritic branches. Morphology is cell-type specific and activity-dependent (pruning and growth continue throughout life).
- **Dendritic spines**: Micron-scale protrusions (~0.5–2 µm) that receive >90% of excitatory synapses. Each spine contains:
  - A **postsynaptic density (PSD)**: A dense protein mesh (~300–500 nm disc) beneath the membrane, containing AMPA receptors, NMDA receptors, scaffolding proteins (PSD-95, Shank, Homer), and signaling enzymes (CaMKII, calcineurin). The PSD is a *computational microcircuit* — not just a receiver.
  - A **spine apparatus**: Stacked smooth ER with calcium pumps (SERCA), enabling local Ca²⁺ storage and release — a mini-ER for signal amplification.
  - **Actin cytoskeleton**: Spines are ~85% actin by protein mass. Rapid polymerization/depolymerization drives spine motility, shape changes (thin ↔ mushroom), and LTP/LTD.
- **Dendritic compartments**: Proximal dendrites receive stronger, faster input; distal dendrites are electrically attenuated but can generate *local regenerative events* (dendritic Na⁺ spikes, Ca²⁺ spikes, NMDA spikes). These are not passive cables — they are active processors with local nonlinearities.
- **Dendritic shaft synapses**: Inhibitory (GABAergic) synapses preferentially target shafts, enabling shunting inhibition — a divisive gain control on dendritic integration.

**Computational analogy**: Dendrites are a deep analog neural network with layer-specific nonlinearities. Spines are learned weights with local memory (PSD protein composition). Dendritic spikes are hidden-layer activations.

### 1.4 Cytoskeleton

The cytoskeleton is the structural, transport, and signaling scaffold — the chassis, highway system, and mechanical transducer.

- **Microtubules (MTs)**: Hollow 25 nm tubes of α/β-tubulin dimers. In axons: uniform plus-end-out polarity; in dendrites: mixed polarity. This polarity difference is the *directional addressing system* for motor-driven transport. MTs are tracks for:
  - **Kinesins** (plus-end-directed): Carry cargo outward (soma → synapse).
  - **Dyneins** (minus-end-directed): Carry cargo inward (synapse → soma).
  - Post-translational modifications (acetylation, detyrosination, polyamination) create a "tubulin code" — a chemical surface pattern that motors and MAPs read to regulate traffic speed, cargo loading, and track stability.
- **Neurofilaments**: Intermediate filaments (10 nm) unique to neurons. Provide structural rigidity and determine axon caliber (and thus conduction velocity). Heavily phosphorylated in mature axons.
- **Actin**: Forms the cortical mesh beneath the membrane, the spine cytoskeleton, and the axonal periodic membrane skeleton (~190 nm rings of adducin-capped short actin filaments linked by spectrin tetramers). Discovered via super-resolution (STORM/PALM), this submembrane lattice gives the axon its elastic resilience.
- **Spectrin**: Tetrameric links (αII/βII in axons, αII/βIV at AIS) forming the periodic membrane skeleton. Mutations cause axonal neuropathies — the lattice is load-bearing.

**Computational analogy**: The cytoskeleton is a railway + signaling substrate. Microtubules = tracks with address labels. Motors = autonomous logistics agents. Actin-spectrin lattice = structural memory and mechanical sensor.

### 1.5 Plasma Membrane

The membrane is the electrochemical interface — simultaneously a capacitor, an insulator, a selective filter, and a signal transducer.

- **Lipid bilayer**: ~5 nm thick, ~1 µF/cm² specific capacitance. Composed of phospholipids (PC, PE, PS, PI), cholesterol (~40 mol%), and sphingolipids. Lipid composition is *asymmetric*: outer leaflet is PC/SM-rich; inner leaflet is PS/PE-rich. PS exposure on the outer leaflet signals apoptosis.
- **Lipid rafts**: Cholesterol-sphingolipid microdomains that concentrate signaling proteins (ion channels, receptors, Src kinases). Dynamic, nanoscale (~10–200 nm) assemblies.
- **Ion channels**: ~300 types encoded in the genome. Key classes:
  - **Voltage-gated**: Na⁺ (Nav1.1–1.9), K⁺ (Kv1–12), Ca²⁺ (Cav1–3), HCN (Ih current)
  - **Ligand-gated**: AMPA, NMDA, GABA-A, nicotinic ACh, 5-HT3
  - **Mechanosensitive**: Piezo1/2, TREK/TRAAK
  - **Gap junctions**: Connexin36 (neuronal), enabling electrical synapses
- **Ion pumps**: Na⁺/K⁺-ATPase (consumes ~40–50% of neuronal ATP), Ca²⁺-ATPase (PMCA), H⁺-ATPase. These maintain the ionic gradients that make signaling possible.
- **Transporters**: Glutamate transporters (EAATs), glucose transporters (GLUT3), monocarboxylate transporters (MCTs). Impaired glutamate reuptake → excitotoxicity.

**Computational analogy**: The membrane is a distributed analog computer. It stores charge (capacitor), selectively conducts ions (programmable resistors), and transduces signals (sensor–effector). Each patch of membrane has its own channel complement — a spatially varying transfer function.

---

## 2. Electrophysiological Mechanisms

### 2.1 Resting Membrane Potential

The resting potential (~−65 to −70 mV in typical central neurons) is a *steady-state disequilibrium* — not a thermodynamic equilibrium but a dynamic balance of ionic leaks and active pumps.

- **Ionic driving forces**:
  - [K⁺]ᵢ ≈ 140 mM, [K⁺]ₒ ≈ 4 mM → E_K ≈ −95 mV (Nernst)
  - [Na⁺]ᵢ ≈ 12 mM, [Na⁺]ₒ ≈ 145 mM → E_Na ≈ +60 mV
  - [Cl⁻]ᵢ ≈ 4–10 mM, [Cl⁻]ₒ ≈ 110 mM → E_Cl ≈ −70 to −80 mV
  - [Ca²⁺]ᵢ ≈ 50–100 nM, [Ca²⁺]ₒ ≈ 1.5 mM → E_Ca ≈ +120 mV
- **Goldman-Hodgkin-Katz equation**: Resting potential is the weighted sum of all permeant ion equilibrium potentials, weighted by their relative permeabilities. At rest, P_K >> P_Na >> P_Cl, so V_rest is dominated by E_K but pulled slightly depolarized by Na⁺ leak.
- **Na⁺/K⁺-ATPase electrogenic contribution**: Pumps 3 Na⁺ out / 2 K⁺ in per cycle → net outward current of ~−5 mV contribution. The *hidden subsidy* keeping the system out of equilibrium.
- **Input resistance (R_in)**: R_in = V_rest / I_leak. Small neurons have high R_in → larger voltage deflection per unit current. This is why small distal dendrites are more excitable despite having fewer channels.

**Computational analogy**: The resting potential is a biased voltage rail maintained by an active current source (pump) compensating resistive leaks. The membrane is a leaky capacitor charged to a setpoint — deviations from setpoint are the signal.

### 2.2 Action Potential Generation & Propagation

The action potential (AP) is a regenerative, all-or-nothing voltage pulse — the fundamental unit of digital communication in the nervous system.

- **Initiation** at the AIS, when V_m reaches threshold (~−55 to −45 mV):
  1. **Rising phase**: Nav1.6 channels open (τ_m ≈ 0.1 ms). Na⁺ influx drives V_m toward E_Na (+60 mV). Peak is typically +30 to +40 mV (doesn't fully reach E_Na because Kv channels begin activating).
  2. **Repolarization**: Kv channels open (delayed rectifier, τ ≈ 0.5–1 ms). K⁺ efflux drives V_m back toward E_K. Nav channels enter inactivated state (h-gate closes).
  3. **Afterhyperpolarization (AHP)**: V_m overshoots below rest (to ~−75 mV) because K⁺ conductance remains elevated while Nav is inactivated. Sculpted by:
     - BK channels (Ca²⁺-activated, fast AHP)
     - SK channels (Ca²⁺-activated, medium AHP)
     - sAHP (slow AHP, channel identity still debated; critical for spike-frequency adaptation)
  4. **Recovery**: Nav channels de-inactivate (τ ~1–5 ms). Na⁺/K⁺-ATPase restores ionic gradients. Net ionic displacement per AP: ~10⁷ Na⁺ in, ~10⁷ K⁺ out.

- **Refractory periods**:
  - **Absolute**: ~1 ms — Nav inactivation prevents re-excitation. Sets max firing rate (~1000 Hz theoretical, ~200–300 Hz typical).
  - **Relative**: ~2–4 ms — elevated threshold due to residual K⁺ conductance and incomplete Nav de-inactivation.

- **Propagation**:
  - **Continuous (unmyelinated)**: AP spreads electrotonically to adjacent membrane. Speed ∝ √(diameter). ~0.5–2 m/s.
  - **Saltatory (myelinated)**: Myelin reduces capacitance and increases membrane resistance. AP "jumps" node to node. Speed ∝ diameter (linear). ~5–150 m/s.
  - **Orthodromic**: The AP cannot easily backpropagate through the AIS into the soma under normal conditions (AIS Kv1 channels create a rectifying barrier). However, *antidromic* propagation into the dendritic tree does occur and serves a signaling function (backpropagating APs → dendritic Ca²⁺ influx → spike-timing-dependent plasticity).
  - **Branch-point filtering**: Impedance mismatch at branch points can cause propagation failure. This is a *computational feature*: conditional routing of the AP based on recent activity and branch state.

**Computational analogy**: The AP is a self-regenerating pulse in a transmission line with repeaters (nodes). It has a refractory period (rate limiting), directionality (diode-like), and branch-point gating (conditional fan-out). The entire axon is a lossless digital bus.

### 2.3 Ion Channel Dynamics

Ion channels are the transistors of the neural circuit — voltage-, ligand-, or mechano-gated pores with complex gating kinetics.

- **Voltage-gated Na⁺ channels (Nav)**:
  - Four homologous domains, each with 6 transmembrane segments (S1–S6). S4 = voltage sensor (gating charges: arginine residues every 3rd position).
  - Three states: Closed → Open → Inactivated. Inactivation is *not* the same as closed — it's a distinct non-conducting state requiring depolarization to enter and hyperpolarization to exit.
  - Nav1.6: Primary at nodes of Ranvier and AIS. Fast activation, persistent current component (0.1–1% of peak) contributing to subthreshold resonance and rhythmic firing.
  - Nav1.1: Predominant in inhibitory interneuron axons. Loss-of-function → epilepsy (inhibition fails before excitation).

- **Voltage-gated K⁺ channels (Kv)**:
  - Kv1 (Shaker): Low-threshold, fast. Abundant in AIS and juxtaparanodal regions. *Axonal cutout switch* — prevents backpropagation, shapes AP waveform.
  - Kv2 (Shab): High-threshold, slow. Somatodendritic. Regulates firing rate and protects against excitotoxicity.
  - Kv3 (Shaw): Fast deactivation. Found in fast-spiking PV+ interneurons. Enables rapid repolarization → high-frequency firing.
  - Kv4 (Shal): A-type current. Dendritic. Suppresses backpropagating APs, controls dendritic excitability.

- **HCN channels (Ih current)**:
  - Activated by hyperpolarization, permeable to Na⁺ and K⁺. Creates a depolarizing "sag" current.
  - Concentrated in distal dendrites. Functions as a *high-pass filter*: attenuates slow inputs, preserves fast inputs. Also contributes to theta-frequency resonance — neurons resonate at specific frequencies, and Ih tunes this resonance.

- **Voltage-gated Ca²⁺ channels (Cav)**:
  - Cav1 (L-type): High-threshold, long-lasting. Dendritic — triggers Ca²⁺-dependent gene transcription and dendritic spikes.
  - Cav2 (P/Q, N, R-type): Presynaptic — mediates vesicle release. R-type is also dendritic and contributes to burst firing.
  - Cav3 (T-type): Low-threshold, transient. Generates *low-threshold Ca²⁺ spikes* in thalamic neurons, underlying oscillatory bursting and sleep spindle generation.

**Computational analogy**: Each channel type is a state machine with voltage-dependent transition rates. The ensemble of channels at any membrane location implements a *transfer function* with time- and voltage-dependent gain.

---

## 3. Synaptic Transmission & Plasticity

### 3.1 Presynaptic Release Machinery

The presynaptic terminal is a probabilistic, calcium-triggered quantal release engine.

- **Vesicle pools**:
  - **Readily releasable pool (RRP)**: ~5–20 vesicles docked at the active zone, primed and ready for release. Replenishment time: ~1–5 s under basal conditions, faster during high-frequency firing (activity-dependent acceleration of priming via Munc13 and CAPS).
  - **Recycling pool**: ~50–100 vesicles that can be mobilized within seconds. Released during moderate-frequency stimulation.
  - **Reserve pool**: Hundreds to thousands of vesicles tethered to the actin cytoskeleton via synapsin. Mobilized only during intense, prolonged activity. Synapsin phosphorylation by CaMKII releases vesicles from the reserve pool.

- **Active zone architecture**: A dense protein lattice (bassoon, piccolo, CAST/ELKS, RIM, Munc13) that positions Ca²⁺ channels (Cav2.1 P/Q-type, Cav2.2 N-type) within ~20 nm of docked vesicles. This nanometer-scale coupling is critical: Ca²⁺ concentration at the vesicle sensor (synaptotagmin) reaches ~10–100 µM within microseconds of channel opening, then collapses rapidly — a *nanodomain* signal. The active zone is not a flat surface; super-resolution reveals it as a topographic grid with precise channel-vesicle registration.

- **Release cascade**:
  1. AP arrives → depolarizes bouton → Cav2 channels open
  2. Ca²⁺ nanodomains form at channel mouths
  3. Synaptotagmin-1 (the Ca²⁺ sensor for fast release) binds 4–5 Ca²⁺ ions via its C2 domains
  4. Synaptotagmin inserts into the presynaptic membrane, pulling it toward the vesicle membrane
  5. SNARE complex (synaptobrevin/VAMP on vesicle + SNAP-25 + syntaxin-1 on membrane) mediates membrane fusion
  6. Fusion pore opens → neurotransmitter release (within ~100 µs of Ca²⁺ entry)
  7. Vesicle collapses into membrane (full collapse) or opens and reseals (kiss-and-run)

- **Release probability (p)**: Typically 0.1–0.5 per AP per active zone. Highly variable between synapses and modifiable by:
  - Residual Ca²⁺ accumulation (facilitation: p increases over successive APs)
  - Presynaptic autoreceptors (e.g., mGluR2, GABA-B: negative feedback)
  - Heterosynaptic modulation via volume transmission
  - Short-term depression: vesicle depletion + presynaptic Ca²⁺ channel inactivation

- **Quantal nature**: Each vesicle releases a *quantum* of neurotransmitter (~3,000–5,000 glutamate molecules per vesicle). Postsynaptic response to a single quantum = quantal amplitude (q). Total postsynaptic response: R = n × p × q, where n = number of release sites. This is the quantal model of synaptic transmission (del Castillo & Katz, 1954).

**Computational analogy**: The presynaptic terminal is a stochastic event generator with a queue (vesicle pools), a trigger (Ca²⁺ sensor), and a probabilistic output (p). Short-term plasticity (facilitation, depression) implements temporal filtering — a dynamic gain control on the input channel.

### 3.2 Synaptic Cleft Dynamics

The synaptic cleft (~20–30 nm gap) is not an empty space — it's a structured extracellular matrix with active clearance mechanisms.

- **Extracellular matrix**: Cell adhesion molecules (neurexin–neuroligin, LRRTM–presynaptic neurexin, EphB–ephrin) span the cleft, aligning pre- and postsynaptic specializations. These are *trans-synaptic organizers*: they nucleate active zone and PSD assembly during development and maintain alignment throughout life.
- **Neurotransmitter diffusion**: Glutamate concentration in the cleft peaks at ~1–3 mM within ~50 µs of release, then decays with a time constant of ~0.5–1 ms. Diffusion is constrained by cleft geometry, glial wrapping, and the presence of macromolecules.
- **Glial participation**: Astrocyte processes enwrap ~60% of synapses in hippocampus (more in cortex). They express glutamate transporters (GLT-1, GLAST) that clear glutamate within ~1–2 ms, preventing spillover to neighboring synapses. Astrocytes also release gliotransmitters (D-serine, ATP, glutamate) that modulate synaptic function.
- **Spillover and cross-talk**: Under conditions of high-frequency release or reduced reuptake, glutamate can escape the synaptic cleft and activate extrasynaptic receptors (e.g., perisynaptic mGluRs, extrasynaptic NMDA receptors). This is a *volume transmission* mode — a slower, more diffuse signaling channel parallel to point-to-point synaptic transmission.

**Computational analogy**: The cleft is a bounded diffusion channel with active cleanup (transporters) and structural alignment (adhesion molecules). Spillover = broadcast channel. Uptake = channel reuse timer.

### 3.3 Postsynaptic Receptors & Signal Transduction

The postsynaptic density is a signal processing microcircuit — not a passive receiver but an active computational module.

- **AMPA receptors (AMPARs)**: Tetrameric ligand-gated ion channels (GluA1–4 subunits). Primary mediators of fast excitatory transmission.
  - Kinetics: Rise time ~0.1–0.5 ms, decay time ~1–5 ms (dependent on subunit composition).
  - Ca²⁺ permeability: GluA2-lacking AMPARs are Ca²⁺-permeable. GluA2 insertion/removal is a major mechanism of synaptic plasticity.
  - Conductance: ~8–30 pS (subunit-dependent). Single-channel conductance increases during LTP (a postsynaptic expression mechanism).
  - Auxiliary subunits: TARPs (γ-2/stargazin, γ-3, γ-4, γ-5, γ-7, γ-8), CNIH2/3, GSG1L. These modify gating kinetics, pharmacology, trafficking, and synaptic anchoring. TARP-γ8 is the dominant auxiliary subunit at hippocampal synapses.

- **NMDA receptors (NMDARs)**: Heterotetrameric (GluN1 + GluN2A–D + optional GluN3). Coincidence detector for Hebbian plasticity.
  - Voltage-dependent Mg²⁺ block: At resting potential, Mg²⁺ occludes the pore. Depolarization (e.g., from AMPAR activation or backpropagating AP) relieves the block.
  - Ca²⁺ permeability: ~10% of current carried by Ca²⁺. This Ca²⁺ influx is the *plasticity trigger*.
  - Slow kinetics: Rise time ~3–7 ms, decay time ~50–250 ms (GluN2B-containing = slower, developmental; GluN2A-containing = faster, mature).
  - Subunit switch: During development, GluN2B → GluN2A shift occurs (activity-dependent). This changes the temporal window for coincidence detection and the downstream signaling cascades.

- **Metabotropic glutamate receptors (mGluRs)**: G-protein-coupled receptors (Group I: mGluR1/5, postsynaptic; Group II/III: presynaptic autoreceptors).
  - Group I mGluRs activate PLCβ → IP₃ + DAG → Ca²⁺ release from internal stores + PKC activation.
  - mGluR-dependent LTD: Requires local protein synthesis (see Section 4). A translation-dependent form of plasticity distinct from CaMKII-dependent LTP.

- **GABA-A receptors**: Pentameric ligand-gated Cl⁻ channels. Primary mediators of fast inhibition.
  - α1β2γ2: Most common subtype. Benzodiazepine-sensitive.
  - α5β3γ2: Extrasynaptic, tonic inhibition. Important for cognitive function.
  - δ-containing: Extrasynaptic, mediate tonic inhibition via ambient GABA. Ethanol-sensitive.
  - E/I balance: The ratio of excitatory to inhibitory conductances is tightly regulated (~4:1 in cortex). Disruption → epilepsy, autism, schizophrenia.

**Computational analogy**: The postsynaptic side is a multi-channel signal processor. AMPAR = fast linear channel. NMDAR = coincidence gate with memory write enable (Ca²⁺). mGluR = slow modulatory channel with local compute (G-protein cascade). GABA-A = inhibitory clamp.

### 3.4 Synaptic Plasticity Mechanisms

Synaptic plasticity is the brain's learning rule — the adaptive modification of synaptic strength based on activity history.

- **Long-term potentiation (LTP)**:
  - **Induction**: Coincident presynaptic activity (glutamate release) + postsynaptic depolarization → NMDAR opening → Ca²⁺ influx → CaMKII activation.
  - **CaMKII as a molecular memory**: Autophosphorylation at T286 converts CaMKII from Ca²⁺-dependent to Ca²⁺-independent activity — a bistable switch. CaMKII translocates to the PSD and phosphorylates AMPAR subunits (GluA1 S831), increasing single-channel conductance.
  - **Expression**: AMPAR insertion into the PSD via PKC phosphorylation of stargazin (TARP-γ2), which increases receptor trapping at synapses. Also, silent synapses (NMDAR-only) become functional by inserting AMPARs.
  - **Structural consolidation**: LTP induces spine enlargement via actin polymerization (cofilin inactivation, Arp2/3 activation). New PSD proteins are synthesized locally. Over 24–72 hours, the enlarged spine is stabilized by new actin-scaffolding linkages and potentially by peri-synaptic astrocyte wrapping.

- **Long-term depression (LTD)**:
  - **NMDAR-dependent LTD**: Low-frequency stimulation → modest Ca²⁺ elevation → calcineurin (PP2B) activation → dephosphorylation of AMPAR subunits and TARPs → AMPAR internalization via clathrin-mediated endocytosis. Calcineurin dephosphorylates inhibitor-1, releasing protein phosphatase 1 (PP1) — a positive feedback loop for dephosphorylation.
  - **mGluR-dependent LTD**: Group I mGluR activation → local protein synthesis of STEP (striatal-enriched phosphatase) and Arc → AMPAR endocytosis. FMRP (fragile X mental retardation protein) normally represses these mRNAs; loss of FMRP → excessive mGluR-LTD → Fragile X syndrome.

- **Spike-timing-dependent plasticity (STDP)**:
  - Pre before post (Δt < +20 ms): LTP. Backpropagating AP + presynaptic glutamate → NMDAR Ca²⁺ influx.
  - Post before pre (Δt < −20 ms): LTD. AP precedes glutamate → subthreshold Ca²⁺ through NMDAR → phosphatase cascade.
  - The STDP window shape varies by cell type, dendritic location, and neuromodulatory state. Dopamine widens the LTP window; acetylcholine narrows it.

- **Homeostatic plasticity (scaling)**:
  - Chronic activity elevation → global reduction in AMPAR conductance and number (scaling down).
  - Chronic activity reduction → global increase (scaling up).
  - Mediated by TNF-α (released by glia), Arc-dependent AMPAR endocytosis, and adjustments in intrinsic excitability (AIS plasticity, Kv channel density changes).
  - Purpose: Maintains E/I balance and prevents runaway excitation/silence.

**Computational analogy**: LTP/LTD = weight update rules. CaMKII autophosphorylation = binary weight bit. STDP = temporally asymmetric learning rule. Homeostatic scaling = batch normalization. The system has multiple timescales: ms (channel gating), sec (short-term plasticity), min (LTP/LTD induction), hours-days (structural consolidation, homeostatic scaling).

---

## 4. Latest 2025/2026 Scientific Nuance

### 4.1 Trans-Synaptic Nanocolumns

Super-resolution microscopy (STORM, PALM, DNA-PAINT, expansion microscopy) has revealed that the synapse is not a diffuse apposition but a *nanocolumn* — a precise trans-synaptic alignment of presynaptic release sites and postsynaptic receptor clusters.

- **Structure**: Presynaptic Cav2 channels cluster within ~30 nm "RIM nanoclusters" directly opposite postsynaptic AMPAR nanoclusters. The alignment is maintained by trans-synaptic adhesion molecules (neurexin–neuroligin, LRRTMs) that function as molecular guide rails.
- **Functional significance**: A single vesicle released from a nanocluster preferentially activates the aligned AMPAR nanocluster — a *private channel* within the synapse. This 1:1 coupling increases the fidelity and efficiency of quantal transmission.
- **Plasticity mechanism**: LTP does not uniformly increase AMPAR number across the PSD. Instead, it drives the *re-alignment* of AMPAR nanoclusters with RIM nanoclusters — structural plasticity of the nanocolumn architecture. During LTP, AMPAR nanoclusters shift toward release sites, increasing coupling probability without necessarily increasing total receptor count.
- **Computational implication**: A single synapse is not a single scalar weight. It is an *array* of nanoscale sub-weights (nanocolumns), each independently tunable. This massively increases the representational capacity of a synapse. A synapse with 5 nanocolumns can encode a 5-dimensional weight vector rather than a scalar.

### 4.2 Localized Translation in Dendrites

Dendrites are not passive cables — they contain a full protein synthesis machinery that operates independently of the soma.

- **mRNA localization**: >2,500 distinct mRNAs are found in neuronal dendrites (transcriptomic studies, 2023–2025). These are transported as ribonucleoprotein (RNP) granules along dendritic microtubules via kinesin (KIF5) and are held in a translationally repressed state by RNA-binding proteins (FMRP, staufen, PUM2, MOV10).

- **Activity-dependent translation**: Synaptic stimulation triggers:
  1. mGluR activation → eIF4E phosphorylation → cap-dependent translation initiation
  2. NMDAR Ca²⁺ influx → CaMKII activation → phosphorylation of CPEB (cytoplasmic polyadenylation element binding protein) → polyadenylation and translational derepression
  3. mTORC1 activation (via PI3K/Akt) → 4E-BP phosphorylation → release of eIF4E → translation initiation
  4. eIF2α phosphorylation *inhibits* general translation but *enhances* selective translation of ATF4 and other stress-response mRNAs — a trade-off mechanism.

- **Key locally synthesized proteins**:
  - **Arc/Arg3.1**: Endocytosis of AMPARs (LTD), scaffolding for synaptic remodeling. Arc mRNA is transported in viral-like capsids formed by Arc protein itself — a remarkable example of neuronal exaptation of retrotransposon architecture.
  - **CaMKIIα**: The α subunit is synthesized locally; the β subunit is soma-derived. This asymmetric synthesis allows local control of holoenzyme composition.
  - **PSD-95**: Local synthesis during LTP stabilizes newly inserted AMPARs.
  - **β-actin**: Local synthesis drives spine enlargement during LTP.

- **Compartmentalized plasticity**: Local translation enables *input-specific* (heterosynaptic) plasticity. A synapse can modify its protein composition without affecting its neighbors — solving the credit assignment problem at the molecular level. This is fundamentally different from a global weight update.

- **Computational implication**: Each spine is a semi-autonomous agent with its own protein synthesis capacity. This enables local learning rules with local memory, independent of a central controller (soma). The dendrite is a distributed compute cluster, not a passive bus.

### 4.3 Organelle Trafficking & Mitochondrial Dynamics

Organelles are not static fixtures — they are dynamically positioned to meet local demand.

- **Mitochondrial positioning**: Miro1/2 (Ca²⁺-sensing outer membrane proteins) anchor mitochondria to kinesin/dynein motors. High local Ca²⁺ *releases* mitochondria from motors, causing them to stop at active synapses. This is a demand-driven parking system.

- **Mitochondrial quality control**: Mitophagy (PINK1/Parkin pathway) selectively degrades damaged mitochondria. Neurons are particularly vulnerable to mitophagy defects — Parkinson's disease (PINK1, Parkin, LRRK2 mutations). Recent work (2025) shows that *localized* mitophagy occurs in distal axons, not just at the soma, enabling compartmentalized quality control.

- **Endoplasmic reticulum in dendrites**: Smooth ER extends into spines (spine apparatus) and dendritic shafts. It serves as:
  - A Ca²⁺ store (IP₃R and RyR channels) for local Ca²⁺ release
  - A lipid synthesis site for membrane expansion during LTP
  - A contact site with mitochondria (MAMs: mitochondria-associated membranes) for Ca²⁺ transfer, phospholipid exchange, and apoptosis signaling

- **Lysosome dynamics**: Axonal lysosomes are not just degradative — they serve as *signaling platforms*. mTORC1 is activated on lysosomal surfaces (via Rag GTPases sensing amino acids). Axonal mTORC1 activity regulates local translation and growth cone guidance.

- **Computational implication**: Organelle positioning is a form of *infrastructure plasticity*. The neuron dynamically repositions its power plants, quality control stations, and signaling hubs to match activity patterns. This is analogous to a data center that physically relocates servers based on traffic patterns.

### 4.4 Perineuronal Nets & Extracellular Matrix Plasticity

- Perineuronal nets (PNNs) are lattice-like extracellular matrix structures that enwrap certain neurons (especially PV+ fast-spiking interneurons). Composed of hyaluronan, chondroitin sulfate proteoglycans (CSPGs: aggrecan, brevican, neurocan, versican), tenascins, and link proteins.
- PNNs stabilize synaptic connections and restrict plasticity — they are the *cement* that locks in critical period circuitry. Enzymatic digestion of PNNs (chondroitinase ABC) reopens critical period plasticity in adult cortex.
- Recent findings (2024–2025): PNNs also function as *ion buffers* (the negatively charged CS-GAG chains buffer cations) and *diffusion barriers* for volume transmission. They are not inert scaffolding but active participants in synaptic signaling.

### 4.5 Axonal Initial Segment Plasticity

- The AIS is not a fixed structure. Chronic depolarization shifts the AIS *distally* (away from the soma), reducing excitability. Chronic hypoactivity shifts it *proximally*, increasing excitability. This occurs over 24–72 hours.
- The mechanism involves Ca²⁺-dependent activation of calcineurin → dephosphorylation of ankyrin-G → detachment and re-assembly at the new position.
- Recent work (2025): AIS plasticity is *cell-type specific*. PV+ interneurons show AIS shortening (not just shifting), while pyramidal cells show position shifts. The net effect: homeostatic rebalancing of excitation/inhibition at the circuit level.

### 4.6 Extrasynaptic & Volume Transmission

- The classical view of synaptic transmission as point-to-point is incomplete. A significant fraction of neurotransmitter signaling occurs *extrasynaptically*:
  - **Dopamine**: >95% of dopamine signaling is volume transmission — released from axon varicosities without classical synapses, diffusing to distant D1/D2 receptors.
  - **Serotonin**: Similarly, most serotonergic signaling is non-synaptic.
  - **Norepinephrine**: Released from locus coeruleus axons in a diffuse, activity-dependent manner.
  - **GABA**: Tonic inhibition via extrasynaptic GABA-A receptors (δ-containing) activated by ambient GABA spillover.
  - **Glutamate**: Extrasynaptic NMDA receptors (containing GluN2B) and mGluRs are activated by spillover during high-frequency activity.
- This creates a *dual signaling architecture*: fast, precise point-to-point (synaptic) + slow, diffuse broadcast (volume). The volume channel is a neuromodulatory layer that sets the global operating context (arousal, attention, reward) for the synaptic layer.

### 4.7 Astrocyte–Neuron Coupling (The Tripartite Synapse)

- Astrocytes are active participants in synaptic signaling:
  - **Glutamate uptake**: GLT-1 and GLAST transporters clear synaptic glutamate within ~1–2 ms. One astrocyte contacts ~100,000 synapses; its Ca²⁺ activity can coordinate glutamate uptake across a large territory.
  - **Gliotransmission**: Astrocytes release D-serine (co-agonist at NMDA receptors — required for receptor activation), ATP (converted to adenosine → A1 receptor-mediated presynaptic inhibition), and glutamate. The physiological relevance of astrocytic glutamate release is debated (2024–2025 literature), but D-serine release is well-established.
  - **Metabolic coupling**: Astrocytes take up synaptic glutamate, convert it to glutamine (via glutamine synthetase), and shuttle glutamine back to neurons for re-synthesis of glutamate — the glutamate–glutamine cycle. Astrocytes also supply lactate (via the astrocyte–neuron lactate shuttle, ANLS) as an energy substrate during intense neuronal activity.
  - **Ca²⁺ signaling**: Astrocytic Ca²⁺ waves propagate slowly (~10–30 µm/s) through gap junction networks. These waves coordinate blood flow (neurovascular coupling) and can modulate groups of synapses simultaneously.

- **Computational implication**: The tripartite synapse adds a *glial processing layer* between input and output. The astrocyte acts as a spatial low-pass filter, a metabolic buffer, and a coordinator of local network state. Any biophysical architecture that ignores glia is missing a key regulatory layer.

### 4.8 Ultrastructural Discoveries from Volume EM

- FIB-SEM (focused ion beam scanning electron microscopy) and serial block-face EM have produced complete 3D reconstructions of neuronal tissue at ~4–8 nm resolution (e.g., the MICrONS consortium dataset: 1 mm³ of mouse visual cortex, 2021–2025).
- Key findings:
  - **Axonal wiring economy**: Axons take surprisingly non-optimal paths, suggesting that developmental constraints (pioneer axons, guidepost cells) and activity-dependent pruning shape connectivity more than pure wire-length minimization.
  - **Synapse diversity**: The assumption of ~7,000 synapses per cortical pyramidal neuron was an underestimate. Volume EM reveals ~10,000–30,000+ depending on cell type and layer, with many *multi-synaptic boutons* (one bouton contacting multiple spines) and *sequential synapses* (axons making chains of contacts along a single dendrite).
  - **Interneuron connectivity**: PV+ basket cells make ~20–40 synapses onto a single pyramidal cell soma and proximal dendrites, forming a *perisomatic basket* — a high-conductance inhibitory clamp. This was known qualitatively but is now quantified with exact numbers.
  - **Extracellular space**: ~20% of brain tissue volume is extracellular space (not 5–10% as previously estimated from electron microscopy artifacts). This has major implications for volume transmission, ion buffering, and drug distribution.

---

## Summary: Architectural Principles for Reverse-Engineering

| Principle | Biological Implementation | Computational Analog |
|-----------|------------------------|---------------------|
| Signal as deviation from setpoint | Resting potential + AP | Biased voltage rail + digital pulse |
| Subthreshold analog processing | Dendritic integration | Deep analog network with nonlinearities |
| Binary decision at gate | AIS/hillock | Comparator + threshold |
| Lossless transmission | Saltatory conduction | Repeater chain / digital bus |
| Probabilistic release | Quantal transmission | Stochastic event generator |
| Multi-timescale plasticity | STP, LTP/LTD, scaling | Temporal filters + weight updates + batch norm |
| Local compute & memory | Spine apparatus, local translation | Distributed agents with local RAM |
| Sub-synaptic weight vectors | Nanocolumns | Array of micro-weights per synapse |
| Coincidence detection | NMDA receptor | AND gate with write-enable |
| Directional transport | Microtubule polarity | Addressed logistics network |
| Dynamic infrastructure | Organelle positioning, AIS plasticity | Infrastructure-as-code, auto-scaling |
| Dual signaling architecture | Synaptic + volume transmission | Point-to-point + broadcast channels |
| Glial regulation | Astrocyte tripartite synapse | Middleware layer (buffer, filter, coordinate) |
| Homeostatic stability | E/I balance, scaling, PNNs | PID controller + structural commitment |

---

*Document generated: 2026-05-31 | Scope: Comprehensive neuron anatomy and mechanisms for computational architecture design.*