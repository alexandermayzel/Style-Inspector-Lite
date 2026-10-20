import test from 'node:test';
import assert from 'node:assert/strict';
import { documentCanvasColor } from '../../src/runtime/document-canvas';

type Failure = 'root-style' | 'create' | 'register' | 'shadow' | 'append' | 'probe-style';

function canvasDocument(failure?: Failure) {
  const events: string[] = [];
  const state = { scheme: 'normal', canvas: 'rgb(248, 249, 250)', resolvedScheme: undefined as string | undefined };
  const fail = (operation: Failure) => { if (failure === operation) throw new Error(`Unavailable ${operation}`); };
  class Probe {
    isConnected = false;
    styles = new Map<string, { value: string; priority: string }>();
    style = { setProperty: (name: string, value: string, priority: string) => this.styles.set(name, { value, priority }) };
    shadowMode?: ShadowRootMode;
    shadowChildren: Probe[] = [];
    attachShadow({ mode }: ShadowRootInit) {
      events.push('shadow'); fail('shadow'); this.shadowMode = mode;
      return { append: (probe: Probe) => { this.shadowChildren.push(probe); events.push('shadow-append'); } };
    }
    remove() {
      events.push('remove'); this.isConnected = false;
      const index = root.children.indexOf(this);
      if (index !== -1) root.children.splice(index, 1);
    }
  }
  const created: Probe[] = [];
  const root = {
    localName: 'html', namespaceURI: 'http://www.w3.org/1999/xhtml',
    children: [] as Probe[],
    append(host: Probe) {
      events.push('connect'); root.children.push(host); host.isConnected = true;
      fail('append');
    },
  };
  const view = {
    top: null as unknown,
    getComputedStyle(element: typeof root | Probe) {
      if (element === root) {
        events.push('root-style'); fail('root-style');
        return { colorScheme: state.scheme };
      }
      events.push('probe-style'); fail('probe-style');
      const probe = element as Probe;
      const host = created.find(candidate => candidate.shadowChildren.includes(probe));
      assert.ok(host?.isConnected, 'Native color resolution requires a connected shadow probe');
      return {
        colorScheme: state.resolvedScheme ?? probe.styles.get('color-scheme')?.value,
        backgroundColor: state.canvas,
      };
    },
  };
  view.top = view;
  const document = {
    documentElement: root, defaultView: view,
    createElement(name: string) {
      events.push('create'); fail('create');
      assert.equal(name, 'span');
      const element = new Probe(); created.push(element); return element;
    },
  };
  const registered: Element[] = [];
  const register = (element: Element) => { events.push('register'); registered.push(element); fail('register'); };
  const read = () => documentCanvasColor(document as unknown as Document, register);
  return { document, root, view, state, created, events, registered, read };
}

test('only top-level HTML documents establish a document canvas', () => {
  const reject = (document: unknown) => assert.equal(documentCanvasColor(document as Document, () => {
    assert.fail('Unsupported documents must not create an owned probe');
  }), null);
  reject(undefined);
  reject({});
  const detached = canvasDocument();
  reject({ ...detached.document, defaultView: null });
  reject({ ...detached.document, documentElement: null });
  const frame = canvasDocument(); frame.view.top = {};
  reject(frame.document);
  const svg = canvasDocument(); svg.root.localName = 'svg'; svg.root.namespaceURI = 'http://www.w3.org/2000/svg';
  reject(svg.document);
  const foreignHtml = canvasDocument(); foreignHtml.root.namespaceURI = 'http://www.w3.org/2000/svg';
  reject(foreignHtml.document);
  const nonHtml = canvasDocument(); nonHtml.root.localName = 'body';
  reject(nonHtml.document);
  for (const fixture of [detached, frame, svg, foreignHtml, nonHtml]) assert.deepEqual(fixture.events, []);
});

test('the native Canvas probe uses the current root scheme and preserves its opaque color', () => {
  for (const scheme of ['normal', 'light', 'dark', 'light dark', 'only light']) {
    const fixture = canvasDocument(); fixture.state.scheme = scheme;
    assert.deepEqual(fixture.read(), {
      raw: 'rgb(248, 249, 250)', rgba: { r: 248, g: 249, b: 250, a: 1 },
    });
    const [host, probe] = fixture.created;
    assert.equal(host.shadowMode, 'closed');
    assert.deepEqual(probe.styles.get('color-scheme'), { value: scheme, priority: 'important' });
    assert.deepEqual(probe.styles.get('background-color'), { value: 'Canvas', priority: 'important' });
    assert.deepEqual(probe.styles.get('forced-color-adjust'), { value: 'none', priority: 'important' });
    assert.deepEqual(host.styles.get('display'), { value: 'none', priority: 'important' });
    assert.deepEqual(host.styles.get('pointer-events'), { value: 'none', priority: 'important' });
    assert.deepEqual(fixture.registered, [host]);
    assert.ok(fixture.events.indexOf('register') < fixture.events.indexOf('connect'));
    assert.ok(fixture.events.indexOf('connect') < fixture.events.indexOf('probe-style'));
    assert.equal(fixture.events.at(-1), 'remove');
    assert.deepEqual(fixture.root.children, []);
    assert.equal(host.isConnected, false);
  }
});

test('missing, unresolved or translucent system colors do not become guessed white', () => {
  for (const canvas of ['', 'Canvas', 'not-a-color', 'transparent', 'rgba(255, 255, 255, 0.5)']) {
    const fixture = canvasDocument(); fixture.state.canvas = canvas;
    assert.equal(fixture.read(), null, canvas);
    assert.deepEqual(fixture.root.children, [], canvas);
    assert.equal(fixture.events.at(-1), 'remove', canvas);
  }
  const missingScheme = canvasDocument(); missingScheme.state.scheme = '';
  assert.equal(missingScheme.read(), null);
  assert.deepEqual(missingScheme.created, []);
  const wrongScheme = canvasDocument(); wrongScheme.state.scheme = 'dark'; wrongScheme.state.resolvedScheme = 'normal';
  assert.equal(wrongScheme.read(), null, 'A computed color for a different scheme does not establish the page canvas');
  const missingResolvedScheme = canvasDocument(); missingResolvedScheme.state.resolvedScheme = '';
  assert.equal(missingResolvedScheme.read(), null);
});

test('native DOM failures return unknown and remove every created host', () => {
  for (const failure of ['root-style', 'create', 'register', 'shadow', 'append', 'probe-style'] as const) {
    const fixture = canvasDocument(failure);
    assert.equal(fixture.read(), null, failure);
    assert.deepEqual(fixture.root.children, [], failure);
    if (fixture.created.length) {
      assert.equal(fixture.events.at(-1), 'remove', failure);
      assert.equal(fixture.created[0].isConnected, false, failure);
    }
  }
});

test('one synchronous measurement batch shares a probe but the next microtask refreshes browser colors', async () => {
  const fixture = canvasDocument();
  const first = fixture.read();
  fixture.state.canvas = 'rgb(18, 19, 20)';
  assert.strictEqual(fixture.read(), first);
  assert.equal(fixture.created.length, 2, 'The second read reuses the batch result');
  await Promise.resolve();
  assert.deepEqual(fixture.read()?.rgba, { r: 18, g: 19, b: 20, a: 1 });
  assert.equal(fixture.created.length, 4, 'A later inspection resolves the browser color again');
  assert.deepEqual(fixture.root.children, []);
});

test('a root scheme change refreshes immediately and cached colors stay document-specific', () => {
  const fixture = canvasDocument(); fixture.read();
  fixture.state.scheme = 'dark'; fixture.state.canvas = 'rgb(18, 19, 20)';
  assert.deepEqual(fixture.read()?.rgba, { r: 18, g: 19, b: 20, a: 1 });
  assert.equal(fixture.created.length, 4);
  assert.deepEqual(fixture.created[3].styles.get('color-scheme'), { value: 'dark', priority: 'important' });
  const other = canvasDocument(); other.state.scheme = 'dark'; other.state.canvas = 'rgb(24, 25, 26)';
  assert.deepEqual(other.read()?.rgba, { r: 24, g: 25, b: 26, a: 1 });
  assert.equal(other.created.length, 2);
});

test('an unresolved canvas is reused only for the current batch', async () => {
  const fixture = canvasDocument(); fixture.state.canvas = 'Canvas';
  assert.equal(fixture.read(), null);
  fixture.state.canvas = 'rgb(255, 255, 255)';
  assert.equal(fixture.read(), null);
  assert.equal(fixture.created.length, 2);
  await Promise.resolve();
  assert.deepEqual(fixture.read()?.rgba, { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(fixture.created.length, 4);
});
