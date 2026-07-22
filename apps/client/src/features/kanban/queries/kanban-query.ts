import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  CardInput,
  IKanbanBoard,
  MoveCardInput,
} from "../types/kanban.types.ts";
import * as service from "../services/kanban-service.ts";

function errorMessage(error: Error): string {
  return error["response"]?.data?.message ?? error.message;
}

export function useBoardsQuery(spaceId?: string) {
  return useQuery({
    queryKey: ["kanban-boards", spaceId],
    queryFn: () => service.listBoards(spaceId!),
    enabled: !!spaceId,
  });
}

export function useBoardQuery(boardId?: string) {
  return useQuery({
    queryKey: ["kanban-board", boardId],
    queryFn: () => service.getBoard(boardId!),
    enabled: !!boardId,
  });
}

export function useCreateBoardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: service.createBoard,
    onSuccess: (_, variables) =>
      queryClient.invalidateQueries({
        queryKey: ["kanban-boards", variables.spaceId],
      }),
    onError: (error: Error) =>
      notifications.show({ color: "red", message: errorMessage(error) }),
  });
}

export function useUpdateBoardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: service.updateBoard,
    onSuccess: (_, variables) =>
      queryClient.invalidateQueries({
        queryKey: ["kanban-board", variables.boardId],
      }),
    onError: (error: Error) =>
      notifications.show({ color: "red", message: errorMessage(error) }),
  });
}

export function useDeleteBoardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: service.deleteBoard,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["kanban-boards"] }),
    onError: (error: Error) =>
      notifications.show({ color: "red", message: errorMessage(error) }),
  });
}

export function useCreateColumnMutation() {
  return boardMutation(service.createColumn);
}

export function useUpdateColumnMutation() {
  return boardMutation(service.updateColumn);
}

export function useMoveColumnMutation() {
  return boardMutation(service.moveColumn);
}

export function useDeleteColumnMutation() {
  return boardMutation(service.deleteColumn);
}

export function useCreateCardMutation() {
  return boardMutation((data: CardInput) => service.createCard(data));
}

export function useUpdateCardMutation() {
  return boardMutation((data: CardInput) => service.updateCard(data));
}

export function useDeleteCardMutation() {
  return boardMutation(service.deleteCard);
}

export function useMoveCardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: service.moveCard,
    onMutate: async (variables: MoveCardInput) => {
      const key = ["kanban-board", variables.boardId];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<IKanbanBoard>(key);
      if (previous) {
        queryClient.setQueryData<IKanbanBoard>(key, {
          ...previous,
          cards: previous.cards.map((card) =>
            card.id === variables.cardId
              ? {
                  ...card,
                  columnId: variables.columnId,
                  position: variables.position,
                }
              : card,
          ),
        });
      }
      return { previous };
    },
    onError: (error: Error, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["kanban-board", variables.boardId],
          context.previous,
        );
      }
      notifications.show({ color: "red", message: errorMessage(error) });
    },
    onSettled: (_, __, variables) =>
      queryClient.invalidateQueries({
        queryKey: ["kanban-board", variables.boardId],
      }),
  });
}

function boardMutation<T extends { boardId: string }, TResult>(
  mutationFn: (data: T) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_, variables) =>
      queryClient.invalidateQueries({
        queryKey: ["kanban-board", variables.boardId],
      }),
    onError: (error: Error) =>
      notifications.show({ color: "red", message: errorMessage(error) }),
  });
}
