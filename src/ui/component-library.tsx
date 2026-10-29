import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Toggle, ToggleGroup } from './buttons.tsx';
import {
  Accordion,
  AccordionItem,
  AppHeader,
  Card,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Menu,
  MenuItem,
  NavigationItem,
  PrimaryNavigation,
  Radio,
  RadioGroup,
  Select,
  Tab,
  Tabs,
  Textarea,
  Input,
} from './primitives.tsx';
import { More, Sparkle } from './icons.tsx';
import { useChrome } from './components.tsx';
import './component-library.css';

function Specimen({
  eyebrow,
  children,
}: {
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <section className="component-specimen">
      <header>
        <span className="component-eyebrow">{eyebrow}</span>
      </header>
      <div className="component-sample">{children}</div>
    </section>
  );
}

/** The name directly above a live component, so the gallery also teaches its vocabulary. */
function ComponentName({ children }: { children: ReactNode }) {
  return <h4 className="component-name">{children}</h4>;
}

/** A live, compact reference for the V1 Studio component vocabulary. */
export function ComponentLibraryPage() {
  useChrome({ framed: false, wide: true });
  const [kind, setKind] = useState<'fragment' | 'thread'>('fragment');
  const [tab, setTab] = useState<'feed' | 'sources'>('feed');
  return (
    <div className="component-library">
      <Link className="back-link system-back-link" to="/more">← more</Link>
      <header className="component-hero">
        <div>
          <p className="component-kicker">Blygger Studio · V1</p>
          <h2>Component library</h2>
          <p>
            A calm, working reference for the controls that make Studio feel like one product.
          </p>
        </div>
        <div className="component-hero-note">
          <span>14</span>
          reusable patterns
        </div>
      </header>

      <div className="component-board">
        <Specimen eyebrow="Actions">
          <ComponentName>Button &gt; Size: Standard; Variant: Default (Secondary), Primary, Plain</ComponentName>
          <div className="component-button-row">
            <Button>save changes</Button>
            <Button variant="primary">publish</Button>
            <Button variant="plain">cancel</Button>
          </div>
          <ComponentName>Button &gt; Size: Medium, Small; IconButton</ComponentName>
          <div className="component-button-row compact">
            <Button size="medium">save draft</Button>
            <Button size="small">reply</Button>
            <IconButton label="more actions"><More /></IconButton>
          </div>
        </Specimen>

        <Specimen eyebrow="Choices">
          <ComponentName>ToggleGroup</ComponentName>
          <ToggleGroup aria-label="post type" value={[kind]}>
            {(['fragment', 'thread'] as const).map((value) => (
              <Toggle
                key={value}
                value={value}
                onClick={() => setKind(value)}
              >
                {value}
              </Toggle>
            ))}
          </ToggleGroup>
          <ComponentName>Tabs</ComponentName>
          <Tabs label="reading view" className="component-tabs" value={tab} onValueChange={(value) => setTab(value as 'feed' | 'sources')}>
            {(['feed', 'sources'] as const).map((value) => (
              <Tab key={value} value={value}>
                {value}
              </Tab>
            ))}
          </Tabs>
          <p className="component-caption">ToggleGroup changes a local choice; Tabs change an in-page view.</p>
        </Specimen>

        <Specimen eyebrow="Forms">
          <ComponentName>Field &gt; Input</ComponentName>
          <Field label="Title" htmlFor="component-title" supportingText="Visible on the public page.">
            <Input id="component-title" defaultValue="A thoughtful fragment" />
          </Field>
          <div className="component-check-grid">
            <div>
              <ComponentName>Checkbox</ComponentName>
              <Checkbox label="Share with followers" defaultChecked />
            </div>
            <div>
              <ComponentName>RadioGroup &gt; Radio</ComponentName>
              <RadioGroup label="Post visibility" name="component-visibility" defaultValue="public">
                <Radio value="public" label="Public" />
                <Radio value="private" label="Private" />
              </RadioGroup>
            </div>
          </div>
          <ComponentName>Select</ComponentName>
          <Select.Root defaultValue="draft" items={{ draft: 'Draft', published: 'Published' }}>
            <Select.Trigger className="system-input select-trigger" aria-label="Post status">
              <Select.Value />
              <Select.Icon aria-hidden="true">⌄</Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner sideOffset={4}>
                <Select.Popup className="select-popup">
                  <Select.List>
                    <Select.Item value="draft" className="select-item"><Select.ItemText>Draft</Select.ItemText><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>
                    <Select.Item value="published" className="select-item"><Select.ItemText>Published</Select.ItemText><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </Specimen>

        <Specimen eyebrow="Feedback">
          <ComponentName>InlineAlert</ComponentName>
          <InlineAlert tone="success" title="Draft saved">
            Your work is safe on this device.
          </InlineAlert>
          <InlineAlert tone="warning" title="One small note">
            This fragment is close to its character limit.
          </InlineAlert>
          <ComponentName>EmptyState</ComponentName>
          <EmptyState
            icon={<Sparkle />}
            title="Nothing here yet"
            description="Start with a small thought."
            action={<Button size="small" variant="primary">compose</Button>}
          />
        </Specimen>

        <Specimen eyebrow="Progressive disclosure">
          <ComponentName>Accordion &gt; AccordionItem</ComponentName>
          <Accordion defaultValue={['edit-note']}>
            <AccordionItem value="edit-note" title="edit note" supportingText="optional">
              <Textarea aria-label="edit note" defaultValue="Clarifies why this changed." rows={2} />
            </AccordionItem>
            <AccordionItem value="attachments" title="attachments" supportingText="0">
              <p className="component-muted">No attachments yet.</p>
            </AccordionItem>
          </Accordion>
          <ComponentName>Card</ComponentName>
          <Card
            header={<strong>Static Card</strong>}
            footer={<span className="component-muted">Use a real link or button for actions.</span>}
          >
            <p className="component-card-copy">A quiet surface for related information—not a generic click target.</p>
          </Card>
        </Specimen>

        <Specimen eyebrow="Wayfinding">
          <ComponentName>AppHeader &gt; PrimaryNavigation &gt; NavigationItem</ComponentName>
          <div className="component-shell-preview">
            <AppHeader title="blyg studio" actions={<IconButton label="more actions"><More /></IconButton>} />
            <PrimaryNavigation label="Studio preview navigation">
              <NavigationItem href="/studio/reading" icon="◫" label="reading" current />
              <NavigationItem href="/studio" icon="✎" label="compose" />
              <NavigationItem href="/studio/more" icon="⋯" label="more" badge="1" />
            </PrimaryNavigation>
          </div>
          <ComponentName>Menu &gt; MenuItem</ComponentName>
          <Menu aria-label="Entry actions">
            <MenuItem icon="⧉" label="copy link" description="Copies a public URL" />
            <MenuItem icon="×" label="withdraw" tone="destructive" />
          </Menu>
        </Specimen>
      </div>

      <footer className="component-library-footer">
        <span>Foundations—colour, type, spacing, radii, shadows, and icons—come next.</span>
        <Link to="/more">back to Studio</Link>
      </footer>
    </div>
  );
}
