import { createRoot } from 'react-dom/client';
import { App } from './App';

// No <React.StrictMode>: in development it runs components and effects twice, so a replica or a
// sync created inside a component would exist twice (two authors in one tab). Here both live in
// session.ts, outside React; leaving StrictMode out keeps that rule from depending on a habit.
createRoot(document.getElementById('root')!).render(<App />);
