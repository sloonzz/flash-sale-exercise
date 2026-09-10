import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { adminLogin, ApiError } from '../api/client.ts';

const adminKeyFormSchema = z.object({
  adminKey: z
    .string({ error: 'Admin key is required' })
    .trim()
    .min(1, 'Admin key is required'),
});
type AdminKeyFormValues = z.infer<typeof adminKeyFormSchema>;

interface Feedback {
  kind: 'error';
  message: string;
}

interface AdminGateFormProps {
  onUnlock: (adminKey: string) => void;
}

export function AdminGateForm({ onUnlock }: AdminGateFormProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const gateForm = useForm<AdminKeyFormValues>({
    resolver: zodResolver(adminKeyFormSchema),
    defaultValues: { adminKey: '' },
  });

  const loginMutation = useMutation({
    mutationFn: (key: string) => adminLogin(key),
  });

  async function unlock(values: AdminKeyFormValues) {
    setFeedback(null);
    try {
      const { adminKey } = await loginMutation.mutateAsync(values.adminKey);
      onUnlock(adminKey);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        gateForm.setError('adminKey', { message: 'Invalid admin key.' });
      } else {
        setFeedback({
          kind: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : 'Something went wrong. Please try again.',
        });
      }
    }
  }

  return (
    <>
      <form
        className="admin-gate"
        onSubmit={gateForm.handleSubmit(unlock)}
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
          {loginMutation.isPending ? 'Checking…' : 'Unlock'}
        </button>
      </form>

      {feedback && (
        <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
      )}
    </>
  );
}
