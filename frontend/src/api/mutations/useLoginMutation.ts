import { useMutation } from '@tanstack/react-query';
import { adminLogin } from '../requests/admin.ts';

export function useLoginMutation() {
  return useMutation({
    mutationFn: (adminKey: string) => adminLogin(adminKey),
  });
}
