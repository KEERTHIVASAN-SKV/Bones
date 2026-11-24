# Coordinator

Small Node.js service outside the kernel. It collects version-vector acks, computes the stable frontier, publishes membership, and runs the manual two-phase "Exorcise" eviction (requirements.md section 10.3). It never evicts a replica automatically.

**Status:** placeholder. Implementation is task KER-077 in `.kiro/specs/crdt-kernel/tasks.md`.
