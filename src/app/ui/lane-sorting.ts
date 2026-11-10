import { moveWorkflowToPosition, reorderWorkflows, type Workflow } from '../../lib/workflow';

export interface LaneSortingDeps {
  getWorkflows: () => Workflow[];
  persistOrder: (next: Workflow[]) => Promise<void>;
}

export function bindLaneSorting({ getWorkflows, persistOrder }: LaneSortingDeps) {
  const lanes = [...document.querySelectorAll<HTMLElement>('[data-project-lane]')];
  let draggedWorkflowId = '';
  const clearLaneClasses = () => lanes.forEach(lane => lane.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after', 'is-drag-shift-up', 'is-drag-shift-down'));
  const clearDragState = () => { clearLaneClasses(); draggedWorkflowId = ''; };
  document.querySelectorAll<HTMLButtonElement>('[data-lane-drag]').forEach(handle => {
    handle.addEventListener('dragstart', event => {
      const workflowId = handle.dataset.laneDrag;
      const lane = handle.closest<HTMLElement>('[data-project-lane]');
      if (!workflowId || !lane || !event.dataTransfer) { event.preventDefault(); return; }
      clearLaneClasses();
      draggedWorkflowId = workflowId;
      lane.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', workflowId);
      // 原生拖拽默认用手柄按钮做预览图，改为整个 Lane 卡片，并让鼠标停在抓取位置
      const laneRect = lane.getBoundingClientRect();
      event.dataTransfer.setDragImage(lane, event.clientX - laneRect.left, event.clientY - laneRect.top);
    });
    handle.addEventListener('dragend', clearDragState);
  });
  lanes.forEach(lane => {
    lane.addEventListener('dragover', event => {
      const draggedId = draggedWorkflowId || event.dataTransfer?.getData('text/plain');
      const targetId = lane.dataset.projectLane;
      if (!draggedId || !targetId || draggedId === targetId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      lanes.forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drag-shift-up', 'is-drag-shift-down'));
      const bounds = lane.getBoundingClientRect();
      const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      lane.classList.add(placement === 'before' ? 'is-drop-before' : 'is-drop-after');
      const draggedIndex = lanes.findIndex(item => item.dataset.projectLane === draggedId);
      const targetIndex = lanes.indexOf(lane);
      if (draggedIndex >= 0 && targetIndex >= 0 && draggedIndex < targetIndex) {
        lanes.slice(draggedIndex + 1, targetIndex + 1).forEach(item => item.classList.add('is-drag-shift-up'));
      } else if (draggedIndex >= 0 && targetIndex >= 0 && draggedIndex > targetIndex) {
        lanes.slice(targetIndex, draggedIndex).forEach(item => item.classList.add('is-drag-shift-down'));
      }
    });
    lane.addEventListener('drop', event => {
      event.preventDefault();
      const draggedId = draggedWorkflowId || event.dataTransfer?.getData('text/plain');
      const targetId = lane.dataset.projectLane;
      const placement = lane.classList.contains('is-drop-after') ? 'after' : 'before';
      clearDragState();
      if (!draggedId || !targetId || draggedId === targetId) return;
      void persistOrder(reorderWorkflows(getWorkflows(), draggedId, targetId, placement));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-lane-move]').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.workflowId;
    const direction = button.dataset.laneMove;
    const currentIndex = getWorkflows().findIndex(workflow => workflow.id === workflowId);
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const target = getWorkflows()[targetIndex];
    if (!workflowId || !target || currentIndex < 0) return;
    void persistOrder(reorderWorkflows(getWorkflows(), workflowId, target.id, direction === 'up' ? 'before' : 'after'));
  }));
  document.querySelectorAll<HTMLInputElement>('[data-lane-position]').forEach(input => {
    const restore = () => {
      const index = getWorkflows().findIndex(workflow => workflow.id === input.dataset.lanePosition);
      if (index >= 0) input.value = String(index + 1);
    };
    input.addEventListener('change', () => {
      const position = Number(input.value);
      const workflowId = input.dataset.lanePosition;
      if (!workflowId || !Number.isInteger(position) || position < 1 || position > getWorkflows().length) { restore(); return; }
      void persistOrder(moveWorkflowToPosition(getWorkflows(), workflowId, position));
    });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { restore(); input.blur(); } });
  });
}
