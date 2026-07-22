import api from "@/lib/api-client.ts";
import {
  CardInput,
  IKanbanBoard,
  IKanbanBoardSummary,
  IKanbanCard,
  IKanbanColumn,
  MoveCardInput,
} from "../types/kanban.types.ts";

export async function listBoards(
  spaceId: string,
): Promise<IKanbanBoardSummary[]> {
  return api.post("/kanban/boards/list", { spaceId });
}

export async function getBoard(boardId: string): Promise<IKanbanBoard> {
  return api.post("/kanban/boards/info", { boardId });
}

export async function createBoard(data: {
  spaceId: string;
  title: string;
}): Promise<IKanbanBoardSummary> {
  return api.post("/kanban/boards/create", data);
}

export async function updateBoard(data: {
  boardId: string;
  title: string;
}): Promise<IKanbanBoardSummary> {
  return api.post("/kanban/boards/update", data);
}

export async function deleteBoard(boardId: string): Promise<void> {
  return api.post("/kanban/boards/delete", { boardId });
}

export async function createColumn(data: {
  boardId: string;
  name: string;
  color?: string | null;
  position: string;
}): Promise<IKanbanColumn> {
  return api.post("/kanban/columns/create", data);
}

export async function updateColumn(data: {
  boardId: string;
  columnId: string;
  name?: string;
  color?: string | null;
}): Promise<IKanbanColumn> {
  return api.post("/kanban/columns/update", data);
}

export async function moveColumn(data: {
  boardId: string;
  columnId: string;
  position: string;
}): Promise<IKanbanColumn> {
  return api.post("/kanban/columns/move", data);
}

export async function deleteColumn(data: {
  boardId: string;
  columnId: string;
}): Promise<void> {
  return api.post("/kanban/columns/delete", data);
}

export async function createCard(data: CardInput): Promise<IKanbanCard> {
  return api.post("/kanban/cards/create", data);
}

export async function updateCard(data: CardInput): Promise<IKanbanCard> {
  return api.post("/kanban/cards/update", data);
}

export async function moveCard(data: MoveCardInput): Promise<IKanbanCard> {
  return api.post("/kanban/cards/move", data);
}

export async function deleteCard(data: {
  boardId: string;
  cardId: string;
}): Promise<void> {
  return api.post("/kanban/cards/delete", data);
}
