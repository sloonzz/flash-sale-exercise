import { ApiError } from './client.ts';
import { errorMessage } from './errors.ts';

export interface Feedback {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

interface MutationLike<TData> {
  isSuccess: boolean;
  isError: boolean;
  data: TData | undefined;
  error: unknown;
}

interface GetMutationFeedbackOptions<TData> {
  onSuccess?: (data: TData) => Feedback | null;
  errorOverrides?: Partial<Record<number, string>>;
  suppressError?: (error: unknown) => boolean;
}

export function getMutationFeedback<TData>(
  mutation: MutationLike<TData>,
  options: GetMutationFeedbackOptions<TData> = {},
): Feedback | null {
  if (mutation.isSuccess) {
    return options.onSuccess?.(mutation.data as TData) ?? null;
  }

  if (mutation.isError) {
    if (options.suppressError?.(mutation.error)) return null;
    return {
      kind: 'error',
      message:
        mutation.error instanceof ApiError
          ? errorMessage(mutation.error, options.errorOverrides)
          : 'Something went wrong. Please try again.',
    };
  }

  return null;
}
