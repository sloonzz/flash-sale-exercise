import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { getMutationFeedback } from '../api/feedback.ts';
import { useLoginMutation } from '../api/mutations/useLoginMutation.ts';

const adminKeyFormSchema = z.object({
  adminKey: z
    .string({ error: 'Admin key is required' })
    .trim()
    .min(1, 'Admin key is required'),
});
type AdminKeyFormValues = z.infer<typeof adminKeyFormSchema>;

interface AdminGateFormProps {
  onLogin: (adminKey: string) => void;
}

export function AdminGateForm({ onLogin }: AdminGateFormProps) {
  const gateForm = useForm<AdminKeyFormValues>({
    resolver: zodResolver(adminKeyFormSchema),
    defaultValues: { adminKey: '' },
  });

  const loginMutation = useLoginMutation();

  const invalidKey =
    loginMutation.error instanceof ApiError &&
    (loginMutation.error.status === 401 || loginMutation.error.status === 403);

  const feedback = getMutationFeedback(loginMutation, {
    suppressError: () => invalidKey,
  });

  function login(values: AdminKeyFormValues) {
    loginMutation.mutate(values.adminKey, {
      onSuccess: ({ adminKey }) => {
        onLogin(adminKey);
      },
      onError: (err) => {
        if (
          err instanceof ApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          gateForm.setError('adminKey', { message: 'Invalid admin key.' });
        }
      },
    });
  }

  return (
    <>
      <form
        className="admin-gate"
        onSubmit={gateForm.handleSubmit(login)}
        noValidate
      >
        <label htmlFor="adminKey">Admin key</label>
        <input
          id="adminKey"
          type="password"
          autoComplete="off"
          {...gateForm.register('adminKey')}
        />
        {gateForm.formState.errors.adminKey && (
          <p className="field-error">
            {gateForm.formState.errors.adminKey.message}
          </p>
        )}
        <button type="submit" disabled={loginMutation.isPending}>
          {loginMutation.isPending ? 'Checking…' : 'Login'}
        </button>
      </form>

      {feedback && (
        <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
      )}
    </>
  );
}
