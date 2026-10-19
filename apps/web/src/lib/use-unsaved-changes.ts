import { useEffect } from 'react';
import { useBlocker, useBeforeUnload } from 'react-router-dom';
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(dirty);
  useBeforeUnload((e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (
        window.confirm('Leave this page with unsaved changes? The draft remains only in this tab.')
      )
        blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
}
