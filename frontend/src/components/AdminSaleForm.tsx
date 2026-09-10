import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import {
  createSaleBodySchema,
  type CreateSaleBody,
  type CreateSaleResponse,
} from 'common';
import { ApiError, createSale } from '../api/client.ts';
import { toDatetimeLocalValue } from '../lib/format.ts';

type SaleFormValues = z.input<typeof createSaleBodySchema>;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function getDefaultSaleTimes() {
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + DAY_IN_MS);
  return {
    startTime: toDatetimeLocalValue(startTime),
    endTime: toDatetimeLocalValue(endTime),
  };
}

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

interface AdminSaleFormProps {
  adminKey: string;
  onInvalidKey: () => void;
}

export function AdminSaleForm({ adminKey, onInvalidKey }: AdminSaleFormProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [created, setCreated] = useState<CreateSaleResponse | null>(null);

  const saleForm = useForm<SaleFormValues, unknown, CreateSaleBody>({
    resolver: zodResolver(createSaleBodySchema),
    defaultValues: { productName: '', ...getDefaultSaleTimes() },
  });

  const createSaleMutation = useMutation({
    mutationFn: (input: CreateSaleBody) =>
      createSale(
        {
          productName: input.productName,
          totalStock: input.totalStock,
          startTime: input.startTime.toISOString(),
          endTime: input.endTime.toISOString(),
        },
        adminKey,
      ),
  });

  async function submitSale(values: CreateSaleBody) {
    setFeedback(null);
    try {
      const sale = await createSaleMutation.mutateAsync(values);
      setCreated(sale);
      setFeedback({ kind: 'success', message: 'Sale saved.' });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        setFeedback({ kind: 'error', message: 'Invalid admin key.' });
        onInvalidKey();
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

  const saleErrors = saleForm.formState.errors;
  const startTimeValue = useWatch({
    control: saleForm.control,
    name: 'startTime',
  });

  return (
    <form
      className="admin-form"
      onSubmit={saleForm.handleSubmit(submitSale)}
      noValidate
    >
      <label htmlFor="productName">Product name</label>
      <input
        id="productName"
        type="text"
        {...saleForm.register('productName')}
      />
      {saleErrors.productName && (
        <p className="field-error">{saleErrors.productName.message}</p>
      )}

      <label htmlFor="totalStock">Stock</label>
      <input
        id="totalStock"
        type="number"
        min={0}
        step={1}
        {...saleForm.register('totalStock', { valueAsNumber: true })}
      />
      {saleErrors.totalStock && (
        <p className="field-error">{saleErrors.totalStock.message}</p>
      )}

      <label htmlFor="startTime">Start time</label>
      <input
        id="startTime"
        type="datetime-local"
        {...saleForm.register('startTime')}
      />
      {saleErrors.startTime && (
        <p className="field-error">{saleErrors.startTime.message}</p>
      )}

      <label htmlFor="endTime">End time</label>
      <input
        id="endTime"
        type="datetime-local"
        min={typeof startTimeValue === 'string' ? startTimeValue : undefined}
        {...saleForm.register('endTime')}
      />
      {saleErrors.endTime && (
        <p className="field-error">{saleErrors.endTime.message}</p>
      )}

      <button type="submit" disabled={createSaleMutation.isPending}>
        {createSaleMutation.isPending ? 'Saving…' : 'Save sale'}
      </button>

      {feedback && (
        <p className={`banner banner-${feedback.kind}`}>{feedback.message}</p>
      )}

      {created && (
        <p className="admin-created">
          Saved <strong>{created.product}</strong> — {created.totalStock} units.
        </p>
      )}
    </form>
  );
}
