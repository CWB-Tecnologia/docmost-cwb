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
  const req = await api.post<IKanbanBoardSummary[]>("/kanban/boards/list", {
    spaceId,
  });
  return req.data;
}

export async function getBoard(boardId: string): Promise<IKanbanBoard> {
  const req = await api.post<IKanbanBoard>("/kanban/boards/info", { boardId });
  return req.data;
}

export async function createBoard(data: {
  spaceId: string;
  title: string;
}): Promise<IKanbanBoardSummary> {
  const req = await api.post<IKanbanBoardSummary>("/kanban/boards/create", data);
  return req.data;
}

export async function updateBoard(data: {
  boardId: string;
  title: string;
}): Promise<IKanbanBoardSummary> {
  const req = await api.post<IKanbanBoardSummary>("/kanban/boards/update", data);
  return req.data;
}

export async function deleteBoard(boardId: string): Promise<void> {
  await api.post("/kanban/boards/delete", { boardId });
}

export async function createColumn(data: {
  boardId: string;
  name: string;
  color?: string | null;
  position: string;
}): Promise<IKanbanColumn> {
  const req = await api.post<IKanbanColumn>("/kanban/columns/create", data);
  return req.data;
}

export async function updateColumn(data: {
  boardId: string;
  columnId: string;
  name?: string;
  color?: string | null;
}): Promise<IKanbanColumn> {
  const req = await api.post<IKanbanColumn>("/kanban/columns/update", data);
  return req.data;
}

export async function moveColumn(data: {
  boardId: string;
  columnId: string;
  position: string;
}): Promise<IKanbanColumn> {
  const req = await api.post<IKanbanColumn>("/kanban/columns/move", data);
  return req.data;
}

export async function deleteColumn(data: {
  boardId: string;
  columnId: string;
}): Promise<void> {
  await api.post("/kanban/columns/delete", data);
}

export async function createCard(data: CardInput): Promise<IKanbanCard> {
  const req = await api.post<IKanbanCard>("/kanban/cards/create", data);
  return req.data;
}

export async function updateCard(data: CardInput): Promise<IKanbanCard> {
  const req = await api.post<IKanbanCard>("/kanban/cards/update", data);
  return req.data;
}

export async function moveCard(data: MoveCardInput): Promise<IKanbanCard> {
  const req = await api.post<IKanbanCard>("/kanban/cards/move", data);
  return req.data;
}

export async function deleteCard(data: {
  boardId: string;
  cardId: string;
}): Promise<void> {
  await api.post("/kanban/cards/delete", data);
}
