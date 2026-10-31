import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { settings as settingsCollection } from './data.ts';
import {
  Button,
  Failure,
  basepath,
  mount,
  useChrome,
  useSettings,
  useUpdateState,
} from './components.tsx';
import { CLIENT } from '../client.ts';
import { compiledExtensions } from '../../build/extensions.ui.ts';
import { enabledExtensions } from './extensions.tsx';

/** The fifth tab: update notices, the less-used screens, the public page, log out. */
export function MorePage() {
  useChrome({ framed: false });
  const settings = useSettings();
  const update = useUpdateState();
  const [error, setError] = useState<unknown>();
  const publicUrl = new URL(`${mount}/`, location.origin).href;
  const pages = enabledExtensions(compiledExtensions, settings?.extensions).filter(
    (extension) => extension.page,
  );
  return (
    <>
      <h2 className="view-h">more</h2>
      <div style={{ height: 10 }} />
      <Failure error={error} />
      {settings?.updateCheck && !settings.updateNoticeAck ? (
        <div className="banner banner-info update-banner notice" id="update-notice">
          <span className="mark" aria-hidden="true">
            i
          </span>
          <div className="body">
            Update alerts are on. You can turn them off in{' '}
            <Link to="/settings">Settings</Link>.{' '}
            <Button
              className="link"
              data-action="ack-update-notice"
              onClick={() =>
                void settingsCollection
                  .update('settings', (row) => {
                    row.updateNoticeAck = true;
                  })
                  .when('settled').catch(setError)
              }
            >
              got it
            </Button>
          </div>
        </div>
      ) : null}
      {settings?.updateCheck && update?.behind ? (
        <div className="banner banner-info update-banner" id="update-behind">
          <span className="mark" aria-hidden="true">
            ↑
          </span>
          <div className="body">
            <p>
              A new version of {CLIENT.name} is available: {update.latest} (this
              build: {CLIENT.version}).
            </p>
            <a href={CLIENT.url + '/releases'} target="_blank" rel="noreferrer">
              release notes ↗
            </a>{' '}
            · Run <code>npm run upgrade</code> to update.
          </div>
        </div>
      ) : null}
      <ul className="nav-list">
        <li>
          <Link to="/access">
            <span className="mi" aria-hidden="true">
              ⚿
            </span>
            <span className="ml">
              client access
              <span className="md">OAuth clients, MCP apps and manual tokens</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
        <li>
          <Link to="/settings">
            <span className="mi" aria-hidden="true">
              ⚙
            </span>
            <span className="ml">settings</span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
        <li>
          <Link to="/signals">
            <span className="mi" aria-hidden="true">
              ♡
            </span>
            <span className="ml">
              signals
              <span className="md">your thumbs and activity, kept private</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
        <li>
          <Link to="/syntax">
            <span className="mi" aria-hidden="true">
              ⌗
            </span>
            <span className="ml">syntax</span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </li>
      </ul>
      {pages.length ? (
        <ul className="nav-list" aria-label="extensions">
          {pages.map((extension) => (
            <li key={extension.name}>
              <Link to="/ext/$name" params={{ name: extension.name }}>
                <span className="mi" aria-hidden="true">
                  ⧉
                </span>
                <span className="ml">
                  {extension.page!.title}
                  <span className="md">extension · {extension.label}</span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="nav-list">
        <li>
          <a
            href={`${mount}/`}
            target="_blank"
            rel="noreferrer"
            aria-label="public page ↗"
          >
            <span className="mi" aria-hidden="true">
              ↗
            </span>
            <span className="ml">
              public page ↗<span className="md">{publicUrl}</span>
            </span>
          </a>
        </li>
        <li>
          <form method="post" action={`${basepath}/logout`}>
            <Button type="submit">
              <span className="mi" aria-hidden="true">
                ⎋
              </span>
              <span className="ml">log out</span>
            </Button>
          </form>
        </li>
      </ul>
      <p className="page-hint">
        {CLIENT.name} {CLIENT.version}
      </p>
    </>
  );
}
