import { CRDT } from '@bones/kernel';

// Scaffold check (D1): the kernel resolves through the '@bones/kernel' alias.
const probe = new CRDT<string>('scaffold.0');
probe.insert(undefined, 'ok');
document.getElementById('root')!.textContent = `kernel loaded: ${probe.getSequence().length} item`;
