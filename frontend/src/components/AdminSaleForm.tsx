import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createSaleBodySchema, type CreateSaleBody } from 'common';
import { getMutationFeedback } from '../api/feedback.ts';
import { useCreateSaleMutation } from '../api/mutations/useCreateSaleMutation.ts';
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

interface AdminSaleFormProps {
  adminKey: string;
}

export function AdminSaleForm({ adminKey }: AdminSaleFormProps) {
  const saleForm = useForm<SaleFormValues, unknown, CreateSaleBody>({
    resolver: zodResolver(createSaleBodySchema),
    defaultValues: { productName: '', ...getDefaultSaleTimes() },
  });

  const createSaleMutation = useCreateSaleMutation();

  const feedback = getMutationFeedback(createSaleMutation, {
    onSuccess: () => ({ kind: 'success', message: 'Sale saved.' }),
  });

  function submitSale(values: CreateSaleBody) {
    createSaleMutation.mutate({
      input: {
        productName: values.productName,
        totalStock: values.totalStock,
        startTime: values.startTime.toISOString(),
        endTime: values.endTime.toISOString(),
      },
      adminKey,
    });
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

      {createSaleMutation.data && (
        <p className="admin-created">
          Saved <strong>{createSaleMutation.data.product}</strong> —{' '}
          {createSaleMutation.data.totalStock} units.
        </p>
      )}
    </form>
  );
}
