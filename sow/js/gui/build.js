// Builds the SIREN Lite editor from gen/layout.json (SIREN's own uidesc views,
// rearranged by tools/make_lite_layout.py): every class maps to its web port.

import {
  ViewContainer, SirenCard, ViewSwitch, TextLabel, CheckBox, SegmentButton, SirenModTabs, OptionMenu,
  SirenKnob, SirenTextButton, SirenLogo, Readout, Meter,
} from './widgets.js';
import { PartialDisplay, EnvCurve, OscWave, WtMenu, LfoEditor } from './displays.js';

const factories = {
  CViewContainer: (env, a) => new ViewContainer(env, a),
  SirenCard: (env, a) => new SirenCard(env, a),
  UIViewSwitchContainer: (env, a) => new ViewSwitch(env, a, (node) => buildView(env, node)),
  CTextLabel: (env, a) => new TextLabel(env, a),
  CCheckBox: (env, a) => new CheckBox(env, a),
  CSegmentButton: (env, a) => new SegmentButton(env, a),
  SirenModTabs: (env, a) => new SirenModTabs(env, a),
  SirenMenu: (env, a) => new OptionMenu(env, a),
  SirenKnob: (env, a) => new SirenKnob(env, a),
  SirenTextButton: (env, a) => new SirenTextButton(env, a),
  SirenLogo: (env, a) => new SirenLogo(env, a),
  SirenReadout: (env, a) => new Readout(env, a),
  SirenMeter: (env, a) => new Meter(env, a),
  SirenPartialDisplay: (env, a) => new PartialDisplay(env, a),
  SirenEnvCurve: (env, a) => new EnvCurve(env, a),
  SirenOscWave: (env, a) => new OscWave(env, a),
  SirenWtMenu: (env, a) => new WtMenu(env, a),
  SirenLfoEditor: (env, a) => new LfoEditor(env, a),
};

export function buildView(env, node) {
  const f = factories[node.class];
  if (!f) {
    console.warn('SOW: no web view for', node.class);
    return null;
  }
  const v = f(env, node.attrs);
  if (node.children && v.children && !(v instanceof ViewSwitch)) {
    for (const c of node.children) {
      const cv = buildView(env, c);
      if (cv) v.add(cv);
    }
  }
  return v;
}
