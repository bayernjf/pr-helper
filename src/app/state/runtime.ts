import type { Screen } from '../../lib/navigation';

// The orchestration callbacks (render/goTo/init) live in main.ts, but modules
// further down the split need to invoke them. main.ts binds the real
// implementations once at module scope via bindRuntime; nothing may call
// these before event time, so the placeholder bodies never run. This keeps
// the dependency direction one-way: modules never import main.ts.
export const runtime: {
  render: () => void;
  goTo: (target: Screen | 'back') => void;
  init: () => Promise<void>;
  returnToSourceLane: (workflowId: string) => void;
  restoreConnection: () => Promise<void>;
  connect: (error?: string) => void;
  openRepositoryManagement: () => void;
} = {
  render: () => {},
  goTo: () => {},
  init: async () => {},
  returnToSourceLane: () => {},
  restoreConnection: async () => {},
  connect: () => {},
  openRepositoryManagement: () => {},
};

export function bindRuntime(impl: { render: () => void; goTo: (target: Screen | 'back') => void; init: () => Promise<void>; returnToSourceLane: (workflowId: string) => void; restoreConnection: () => Promise<void>; connect: (error?: string) => void; openRepositoryManagement: () => void }) {
  Object.assign(runtime, impl);
}
