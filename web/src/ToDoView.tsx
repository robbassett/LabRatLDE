import InboxView from './InboxView';
import SignoffView from './SignoffView';
import type { Tab as WorkspaceTab } from './tabs';
import type { ToDo } from './todo';
import { Tab, TabList, TabPanel, Tabs } from './ui';

// ToDoView (SPEC-025-R12) merges the review inbox and the sign-off inbox: one
// place for everything waiting on the user.
export default function ToDoView({
  sub,
  onSub,
  todo,
  open,
}: {
  sub: string | undefined;
  onSub: (sub: string) => void;
  todo: ToDo | null;
  open: (t: WorkspaceTab) => void;
}) {
  const selected = sub === 'signoff' ? 'signoff' : 'review';
  const count = (n: number | undefined) => (n === undefined ? '' : ` (${n})`);
  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>To do</h1>
          <p className="subtitle">Changes to review and runs to sign.</p>
        </div>
      </div>
      <Tabs selectedKey={selected} onSelectionChange={(k) => onSub(String(k))}>
        <TabList aria-label="To do">
          <Tab id="review">Review changes{count(todo?.reviews.length)}</Tab>
          <Tab id="signoff">Sign-offs{count(todo?.signoffs.length)}</Tab>
        </TabList>
        <TabPanel id="review">
          <InboxView />
        </TabPanel>
        <TabPanel id="signoff">
          <SignoffView open={open} />
        </TabPanel>
      </Tabs>
    </article>
  );
}
