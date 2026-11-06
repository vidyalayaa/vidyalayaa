import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  dismissible = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  trigger?: ReactNode;
  dismissible?: boolean;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="dialog-content fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
          onEscapeKeyDown={dismissible ? undefined : (event) => event.preventDefault()}
          onInteractOutside={dismissible ? undefined : (event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="text-xl font-semibold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-6 mt-2 text-sm text-stone-500">
            {description ||
              'Complete the details below. Changes are saved securely to your school.'}
          </DialogPrimitive.Description>
          {dismissible && (
            <DialogPrimitive.Close
              className="absolute right-4 top-4 rounded-lg p-2 hover:bg-stone-100"
              aria-label="Close dialog"
            >
              <X size={18} />
            </DialogPrimitive.Close>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
