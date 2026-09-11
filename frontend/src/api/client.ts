export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Could not reach the server', 0);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const bodyMessage =
      body && typeof body === 'object' && 'message' in body
        ? (body as { message: unknown }).message
        : null;
    const message =
      typeof bodyMessage === 'string' && bodyMessage.length > 0
        ? bodyMessage
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}
