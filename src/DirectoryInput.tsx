import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import './DirectoryInput.css';

interface Directory {
  name: string;
  path: string;
  readable: boolean;
  writable: boolean;
}

interface DirectoryResult {
  directory: string | null;
  parent: string | null;
  current: Directory | null;
  suggestedRoots: boolean;
  suggestions: Directory[];
  truncated: boolean;
}

function withSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

export function DirectoryInput({ value, onChange, label, id, placeholder, allowNew = false }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  placeholder?: string;
  allowNew?: boolean;
}) {
  const generatedId = useId();
  const inputId = id ?? `directory-${generatedId}`;
  const listId = `${inputId}-options`;
  const statusId = `${inputId}-status`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<DirectoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null);
    setActive(-1);
    setError('');
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/storage/directories?path=${encodeURIComponent(value)}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Unable to discover folders.');
        if (!controller.signal.aborted) setResult(data);
      } catch (requestError) {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, value]);

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  function navigate(directory: string) {
    const next = withSlash(directory);
    if (next !== value) setResult(null);
    setActive(-1);
    setOpen(true);
    onChange(next);
    inputRef.current?.focus();
  }

  function useFolder(directory: string) {
    onChange(directory);
    setOpen(false);
    setActive(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const suggestions = result?.suggestions ?? [];
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (!suggestions.length) return;
      setActive((current) => event.key === 'ArrowDown'
        ? (current + 1) % suggestions.length
        : (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (active >= 0 && suggestions[active]) navigate(suggestions[active].path);
      else if (result?.current) useFolder(result.current.path);
      else setOpen(false);
    } else if (event.key === 'Tab' && open) {
      if (active >= 0 && suggestions[active]) onChange(suggestions[active].path);
      setOpen(false);
    }
  }

  let status = 'Type a path to find folders on the server.';
  if (loading) status = 'Looking for folders…';
  else if (error) status = error;
  else if (result?.truncated) status = 'Showing the first 100 matches. Keep typing to narrow the list.';
  else if (result && !result.suggestions.length) status = result.current
    ? 'No subfolders. Use this folder, or go up a level.'
    : allowNew && value.startsWith('/')
      ? 'No matching folder. You can keep this path for a new quarantine folder.'
      : 'No matching folders. Check the spelling or browse from /.';
  else if (result) status = 'Click a folder to look inside. Use this folder to finish. ↑ ↓ Enter also work.';

  return (
    <div className="directory-input" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <input ref={inputRef} id={inputId} role="combobox" aria-label={label} aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? listId : undefined} aria-describedby={open ? statusId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off" spellCheck={false} maxLength={4096} value={value} placeholder={placeholder}
        onFocus={() => setOpen(true)} onKeyDown={keyDown}
        onChange={(event) => { setResult(null); setActive(-1); setOpen(true); onChange(event.target.value); }} />
      {open && <div className="directory-picker">
        <div className="directory-picker-heading">
          <span title={result?.directory ?? ''}>{result?.suggestedRoots ? 'Available storage' : result?.directory ?? 'Server folders'}</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(result?.parent ?? '/')}>{result?.parent ? '↑ Up' : 'Browse /'}</button>
        </div>
        <div id={listId} role="listbox" aria-label={`${label} suggestions`} className="directory-options" aria-busy={loading}>
          {result?.suggestions.map((directory, index) => <button type="button" role="option" tabIndex={-1}
            id={`${listId}-${index}`} aria-selected={index === active} key={directory.path}
            className={`directory-option ${index === active ? 'active' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(directory.path)}>
            <span className="directory-symbol" aria-hidden="true">↳</span>
            <span className="directory-option-name" title={directory.path}>{withSlash(result.suggestedRoots ? directory.path : directory.name)}</span>
            {!directory.readable ? <small>No access</small> : !directory.writable ? <small>Read-only</small> : null}
            <span aria-hidden="true">›</span>
          </button>)}
        </div>
        {result?.current && <button type="button" className="directory-use" onMouseDown={(event) => event.preventDefault()}
          onClick={() => useFolder(result.current!.path)} title={result.current.path}>
          Use this folder <span>{result.current.path}</span>{!result.current.writable && <small>Read-only</small>}
        </button>}
        <p id={statusId} className={`directory-status ${error ? 'error' : ''}`} role="status">{status}</p>
      </div>}
    </div>
  );
}
