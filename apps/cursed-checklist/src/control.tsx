import { createRoot } from 'react-dom/client';
import { ControlApp } from './ControlApp';
import { coordinator } from './controlSession';

// The coordinator lives outside React (controlSession.ts), like the replica in the app page.
createRoot(document.getElementById('root')!).render(<ControlApp coordinator={coordinator} />);
