import { useCallback, useEffect, useState } from 'react';
import { listChangeSets, listSignoff, type ChangeSetSummary, type SignoffItem } from './api';
import { loadMe } from './me';
import { onToast } from './Toasts';

export type ToDo = { signoffs: SignoffItem[]; reviews: ChangeSetSummary[] };

// humanOf names the human behind an actor: "dana via bot" acts for dana.
export function humanOf(actor: string): string {
  return actor.split(' via ')[0];
}

// loadToDo reads what waits for the user (SPEC-025-R12): runs at their signing
// step, and proposed change requests someone else wrote (first page of each).
export async function loadToDo(): Promise<ToDo> {
  const [me, signoffs, proposed] = await Promise.all([loadMe(), listSignoff(), listChangeSets({ state: 'proposed' })]);
  const reviews = proposed.items.filter((c) => humanOf(c.author) !== humanOf(me.actor));
  return { signoffs: signoffs.items, reviews };
}

// useToDo keeps the count fresh: on window focus and after any successful action.
export function useToDo(): { todo: ToDo | null; reload: () => void } {
  const [todo, setTodo] = useState<ToDo | null>(null);
  const reload = useCallback(() => {
    loadToDo()
      .then(setTodo)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener('focus', reload);
    const off = onToast((kind) => kind === 'success' && reload());
    return () => {
      window.removeEventListener('focus', reload);
      off();
    };
  }, [reload]);
  return { todo, reload };
}
