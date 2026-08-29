import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

interface ModalDialogProps {
  open: boolean;
  labelledBy: string;
  describedBy?: string;
  className?: string;
  dialogRef?: RefObject<HTMLDialogElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
  onDismiss: () => void;
  children: ReactNode;
}

export function ModalDialog({
  open,
  labelledBy,
  describedBy,
  className = '',
  dialogRef: externalDialogRef,
  initialFocusRef,
  dismissible = true,
  onDismiss,
  children,
}: ModalDialogProps) {
  const internalDialogRef = useRef<HTMLDialogElement>(null);
  const dialogRef = externalDialogRef ?? internalDialogRef;

  function requestDismiss() {
    const dialog = dialogRef.current;
    if (dismissible && dialog?.open) dialog.close();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      const frame = window.requestAnimationFrame(() => initialFocusRef?.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }

    if (!open && dialog.open) dialog.close();
  }, [initialFocusRef, open]);

  return (
    <dialog
      ref={dialogRef}
      className={`modal-dialog ${className}`.trim()}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        requestDismiss();
      }}
      onClose={onDismiss}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        requestDismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
