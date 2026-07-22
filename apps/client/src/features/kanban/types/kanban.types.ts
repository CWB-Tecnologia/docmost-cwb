export type KanbanPriority = "low" | "medium" | "high" | "urgent";

export interface IKanbanBoardSummary {
  id: string;
  title: string;
  spaceId: string;
  workspaceId: string;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IKanbanColumn {
  id: string;
  boardId: string;
  name: string;
  color: string | null;
  position: string;
  createdAt: string;
  updatedAt: string;
}

export interface IKanbanCard {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  position: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  assigneeAvatarUrl?: string | null;
  priority: KanbanPriority | null;
  dueDate: string | null;
  labels: string[];
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IKanbanBoard extends IKanbanBoardSummary {
  columns: IKanbanColumn[];
  cards: IKanbanCard[];
}

export interface CardInput {
  boardId: string;
  columnId?: string;
  cardId?: string;
  title?: string;
  description?: string | null;
  position?: string;
  assigneeId?: string | null;
  priority?: KanbanPriority | null;
  dueDate?: string | null;
  labels?: string[];
}

export interface MoveCardInput {
  boardId: string;
  cardId: string;
  columnId: string;
  position: string;
}
