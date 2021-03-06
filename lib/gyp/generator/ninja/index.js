'use strict';

// TODO(indutny): replace with minimal-assert
const path = require('path');
const fs = require('fs');

const gyp = require('../../../gyp');
const Writer = require('./writer');

const generatorDefaultVariables = {
  'EXECUTABLE_PREFIX': '',
  'EXECUTABLE_SUFFIX': '',
  'STATIC_LIB_PREFIX': 'lib',
  'STATIC_LIB_SUFFIX': '.a',
  'SHARED_LIB_PREFIX': 'lib',

  /* Gyp expects the following variables to be expandable by the build
   * system to the appropriate locations.  Ninja prefers paths to be
   * known at gyp time.  To resolve this, introduce special
   * variables starting with $! and $| (which begin with a $ so gyp knows it
   * should be treated specially, but is otherwise an invalid
   * ninja/shell variable) that are passed to gyp here but expanded
   * before writing out into the target .ninja files; see
   * ExpandSpecial.
   * $! is used for variables that represent a path and that can only appear at
   * the start of a string, while $| is used for variables that can appear
   * anywhere in a string.
   */
  'INTERMEDIATE_DIR': '$!INTERMEDIATE_DIR',
  'SHARED_INTERMEDIATE_DIR': '$!PRODUCT_DIR/gen',
  'PRODUCT_DIR': '$!PRODUCT_DIR',
  'CONFIGURATION_NAME': '$|CONFIGURATION_NAME',

  /* Special variables that may be used by gyp 'rule' targets.
   * We generate definitions for these variables on the fly when processing a
   * rule.
   */
  'RULE_INPUT_ROOT': '${root}',
  'RULE_INPUT_DIRNAME': '${dirname}',
  'RULE_INPUT_PATH': '${source}',
  'RULE_INPUT_EXT': '${ext}',
  'RULE_INPUT_NAME': '${name}'
};
exports.generatorDefaultVariables = generatorDefaultVariables;

exports.generatorAdditionalNonConfigurationKeys = [];
exports.generatorAdditionalPathSections = [];
exports.generatorExtraSourcesForRules = [];
exports.generatorFilelistPaths = undefined;
exports.generatorSupportsMultipleToolsets = gyp.common.crossCompileRequested();


function calculateVariables(defaultVariables, params) {
  function setdef(key, val) {
    if (!defaultVariables.hasOwnProperty(key))
      defaultVariables[key] = val;
  }

  // TODO(indutny): allow override?
  if (process.platform === 'darwin') {
    setdef('OS', 'mac');
    setdef('SHARED_LIB_SUFFIX', '.dylib');
    setdef('SHARED_LIB_DIR', generatorDefaultVariables['PRODUCT_DIR']);
    setdef('LIB_DIR', generatorDefaultVariables['PRODUCT_DIR']);
  } else if (process.platform === 'win32') {
    setdef('OS', 'win')
    defaultVariables['EXECUTABLE_SUFFIX'] = '.exe';
    defaultVariables['STATIC_LIB_PREFIX'] = ''
    defaultVariables['STATIC_LIB_SUFFIX'] = '.lib';
    defaultVariables['SHARED_LIB_PREFIX'] = ''
    defaultVariables['SHARED_LIB_SUFFIX'] = '.dll';
  } else {
    setdef('OS', process.platform);
    setdef('SHARED_LIB_SUFFIX', '.so');
    setdef('SHARED_LIB_DIR', path.join('$!PRODUCT_DIR', 'lib'));
    setdef('LIB_DIR', path.join('$!PRODUCT_DIR', 'obj'));
  }
};
exports.calculateVariables = calculateVariables;

function Ninja({ index, outDir, target, targetDict, ninjas, config } = extra) {
  const [ buildFile, targetName, toolset ] =
      gyp.common.parseQualifiedTarget(target);

  let obj = 'obj';
  if (toolset !== 'target')
    obj += '.' + toolset;

  this.index = 0;
  this.ninjas = ninjas;
  this.config = config;

  this.targetName = targetName;
  this.targetDict = targetDict;

  this.outDir = outDir;
  this.intDir = path.dirname(buildFile);
  this.objDir = path.join(outDir, obj, this.intDir);
  this.srcDir = path.dirname(buildFile);
  this.useCxx = false;

  const filename = path.join(this.objDir, targetName) + '.ninja';
  this.n = new Writer(filename);
  this.filename = filename;

  this.flavor = process.platform;
  this.objExt = this.flavor === 'win32' ? '.obj' : '.o';
}

Ninja.prototype.expand = function expand(p, productDir = '.') {
  if (productDir === '.')
    p = p.replace(/\$!PRODUCT_DIR[\\\/]/g, '');
  p = p.replace(/\$!PRODUCT_DIR/g, productDir);

  // TODO(indutny): verify this
  if (/\$!INTERMEDIATE_DIR/g.test(p)) {
    const intDir = path.join(productDir, this.intDir, 'gen');
    p = p.replace(/\$!INTERMEDIATE_DIR/g, intDir);
  }

  return p.replace(/\$\|CONFIGURATION_NAME/g, this.config);
};

Ninja.prototype.srcPath = function srcPath(p) {
  if (/^\$!/.test(p))
    return this.expand(p);
  p = this.expand(p);
  return gyp.common.cachedRelative(this.outDir, path.join(this.srcDir, p));
};

function escapeDefine(s) {
  // TODO(indutny): more
  if (/"/.test(s))
    return '\'' + s + '\'';
  return s;
}

Ninja.prototype.type = function type() {
  return this.targetDict.type;
};

Ninja.prototype.output = function output() {
  const targetDict = this.targetDict;
  let res = [];

  const gdv = generatorDefaultVariables;
  let prefix;
  let suffix;

  const type = this.type();
  if (type === 'static_library') {
    prefix = gdv.STATIC_LIB_PREFIX;
    suffix = gdv.STATIC_LIB_SUFFIX;
  } else if (type === 'executable') {
    prefix = gdv.EXECUTABLE_PREFIX;
    suffix = gdv.EXECUTABLE_SUFFIX;
  } else if (type === 'none') {
    // pass through
    prefix = '';
    suffix = '';
  } else {
    throw new Error('Not implemented');
  }

  let out = this.targetName + suffix;
  if (out.indexOf(prefix) !== 0)
    out = prefix + out;

  if (type !== 'none')
    res.push(out);

  const actions = this.targetDict.actions || [];
  actions.forEach((action) => {
    res = res.concat((action.outputs || []).map(o => this.srcPath(o)));
  });

  if (res.length !== 0)
    return res;

  // Empty output, output dependencies (our recursively)
  res = res.concat(this.deps());
  return res;
};

Ninja.prototype.deps = function deps() {
  let res = [];
  (this.targetDict.dependencies || []).forEach((dep) => {
    const depOut = this.ninjas[dep].output();
    res = res.concat(depOut);
  });
  return res;
};

Ninja.prototype.vars = function vars() {
  const targetDict = this.targetDict;

  this.n.section('variables');

  let cflags = [];
  let cflags_c = [];
  let cflags_cc = [];
  let ldflags = [];
  let libs = [];

  // TODO(indutny): windows
  cflags = cflags.concat(
      (targetDict.include_dirs || []).map(dir => `-I${this.srcPath(dir)}`));
  cflags = cflags.concat(
      (targetDict.defines || []).map(def => escapeDefine(`-D${def}`)));

  // OSX uses xcode_settings for cflags, ldflags
  if (this.flavor !== 'darwin' && this.flavor !== 'win32') {
    cflags = cflags.concat(targetDict.cflags || []);
    cflags_c = cflags_c.concat(targetDict.cflags_c || []);
    cflags_cc = cflags_cc.concat(targetDict.cflags_cc || []);
    ldflags = ldflags.concat(targetDict.ldflags || []);
  }

  if (this.flavor === 'darwin' && targetDict.xcode_settings) {
    const xc = targetDict.xcode_settings;
    cflags = cflags.concat(xc.OTHER_CFLAGS || []);
    cflags = cflags.concat(xc.WARNING_CFLAGS || []);
    ldflags = ldflags.concat(xc.OTHER_LDFLAGS || []);

    if (xc.CLANG_WARN_CONSTANT_CONVERSION === 'YES')
      cflags.push('-Wconstant-conversion');
    if (xc.GCC_CHAR_IS_UNSIGNED_CHAR === 'YES')
      cflags.push('-funsigned-char')
    if (xc.GCC_CW_ASM_SYNTAX !== 'NO')
      cflags.push('-fasm-blocks');
    if (xc.GCC_OPTIMIZATION_LEVEL)
      cflags.push(`-O${xc.GCC_OPTIMIZATION_LEVEL}`);
    else
      cflags.push('-Os');
    if (xc.GCC_DYNAMIC_NO_PIC === 'YES')
      cflags.push('-mdynamic-no-pic');
    if (xc.ARCHS && xc.ARCHS.length === 1)
      cflags.push(`-arch ${xc.ARCHS[0]}`);
    else
      cflags.push('-arch i386')

    if (xc.GCC_C_LANGUAGE_STANDARD === 'ansi')
      cflags_c.push('-ansi');
    else if (xc.GCC_C_LANGUAGE_STANDARD)
      cflags_c.push(`-std=${xc.GCC_C_LANGUAGE_STANDARD}`);

    if (xc.CLANG_CXX_LANGUAGE_STANDARD)
      cflags_cc.push(`-std=${xc.CLANG_CXX_LANGUAGE_STANDARD}`);
    if (xc.GCC_ENABLE_CPP_EXCEPTIONS === 'NO')
      cflags_cc.push('-fno-exceptions');
    if (xc.GCC_ENABLE_CPP_RTTI === 'NO')
      cflags_cc.push('-fno-rtti');
    if (xc.GCC_THREADSAFE_STATICS === 'NO')
      cflags_cc.push('-fno-threadsafe-statics');
    if (xc.GCC_INLINES_ARE_PRIVATE_EXTERN === 'YES')
      cflags_cc.push('-fvisibility-inlines-hidden');

    if (xc.MACOSX_DEPLOYMENT_TARGET)
      cflags.push(`-mmacosx-version-min=${xc.MACOSX_DEPLOYMENT_TARGET}`);
  }

  // TODO(indutny): library_dirs
  libs = libs.concat(targetDict.libraries || []);

  const prepare = (list) => {
    return this.n.escape(list.map(v => this.expand(v)).join(' ').trim());
  };

  // TODO(indutny): special preparation for ldflags on OS X
  if (ldflags.length !== 0)
    this.n.declare('ldflags', prepare(ldflags));
  if (libs.length !== 0)
    this.n.declare('libs', prepare(Array.from(new Set(libs))));
  if (cflags.length !== 0)
    this.n.declare('cflags', prepare(cflags));
  if (cflags_c.length !== 0)
    this.n.declare('cflags_c', prepare(cflags_c));
  if (cflags_cc.length !== 0)
    this.n.declare('cflags_cc', prepare(cflags_cc));

  this.n.sectionEnd('variables');
};

Ninja.prototype.actions = function actions() {
  const actions = this.targetDict.actions || [];

  this.n.section('actions');

  const deps = this.deps();

  let res = [];
  actions.forEach((action) => {
    const actionRule = action.action_name + '_' + this.index;

    const base = gyp.common.cachedRelative(this.outDir, this.srcDir);
    const toBase = gyp.common.cachedRelative(this.srcDir, this.outDir);

    // TODO(indutny): WINDOWS!
    this.n.rule(actionRule, {
      description: action.message,
      command: this.n.escape(`cd ${base} && ` +
               `${action.action.map(c => this.expand(c, toBase)).join(' ')}`)
    });

    const inputs = (action.inputs || []).map(i => this.srcPath(i));
    const outputs = (action.outputs || []).map(i => this.srcPath(i));

    res = res.concat(outputs);

    this.n.build(actionRule, outputs, inputs, {
      implicitDeps: deps
    });
  });

  this.n.sectionEnd('actions');

  return res;
};

Ninja.prototype.generate = function generate() {
  const targetDict = this.targetDict;

  this.vars();

  const deps = this.actions().concat(this.deps());

  this.n.section('objects');

  let objs = [];
  (targetDict.sources || []).forEach((originalSource) => {
    // Ignore non-buildable sources
    if (!/\.(c|cc|cpp|cxx|s|S|asm)/.test(originalSource))
      return;

    // Get relative path to the source file
    let source = this.srcPath(originalSource);
    originalSource = this.expand(originalSource);

    // TODO(indutny): objc
    const cxx = /\.(cc|cpp|cxx)$/.test(source);
    if (cxx)
      this.useCxx = true;

    const objBasename = this.targetName + '.' +
                        path.basename(originalSource).replace(/\.[^.]+$/, '') +
                        this.objExt;

    const obj = gyp.common.cachedRelative(
        this.outDir,
        this.objDir + '/' + path.dirname(originalSource) + '/' + objBasename);
    this.n.build(cxx ? 'cxx' : 'cc', [ obj ], [ source ], {
      orderOnlyDeps: deps
    });

    objs.push(obj);
  });

  objs = objs.concat(deps);

  this.n.sectionEnd('objects');

  this.n.section('result');

  const out = this.output();
  const type = this.type();
  let rule;
  if (type === 'static_library')
    rule = 'alink';
  else if (type === 'executable')
    rule = 'link';

  function filterLinkable(obj) {
    // Do not link archives to archives
    if (type === 'static_library')
      return /\.(o|obj)$/.test(obj);

    return /\.(o|a|obj|dll|so|lib)$/.test(obj);
  }

  function filterNotLinkable(obj) {
    return !filterLinkable(obj);
  }

  if (rule) {
    this.n.build(rule, [ out[0] ], objs.filter(filterLinkable), {
      implicitDeps: objs.filter(filterNotLinkable).concat(deps)
    });
  }

  this.n.sectionEnd('result');

  this.n.finalize();
  return this.filename;
};

function NinjaMain(targetList, targetDicts, data, params, config) {
  this.targetList = targetList;
  this.targetDicts = targetDicts;
  this.data = data;
  this.params = params;
  this.config = config;

  const options = params.options;
  this.genDir = path.relative(options.generatorOutput || '.', '.');
  this.outDir = path.normalize(path.join(
      this.genDir,
      options.generator_flags && options.generator_flags.output_dir ||
          'out'));
  this.configDir = path.join(this.outDir, this.config);

  this.n = new Writer(path.join(this.configDir, 'build.ninja'));

  this.ninjas = {};
}

NinjaMain.prototype.generate = function generate() {
  this.vars();
  this.rulesAndTargets();
  this.defaults();
};

NinjaMain.prototype.vars = function vars() {
  const main = this.n;

  // TODO(indutny): env variable override
  main.section('variables');

  const env = process.env;
  let cc;
  let cxx;
  if (process.platform === 'darwin') {
    cc = 'clang';
    cxx = 'clang++';
  } else if (process.platform === 'win32') {
    // ...
  } else {
    cc = 'gcc';
    cxx = 'g++';
  }
  main.declare('cc', env.CC || cc);
  main.declare('cxx', env.CXX || cxx);
  main.declare('ld', env.CC || cc);
  main.declare('ldxx', env.CXX || cxx);
  main.declare('ar', env.AR || 'ar');

  main.sectionEnd('variables');
};

NinjaMain.prototype.rulesAndTargets = function rulesAndTargets() {
  const main = this.n;

  main.section('rules');

  main.pool('link_pool', {
    depth: 4
  });

  main.rule('cc', {
    depfile: '$out.d',
    deps: 'gcc',
    command: '$cc -MMD -MF $out.d $cflags $cflags_c -c $in -o $out',
    description: 'CC $out'
  });

  main.rule('cxx', {
    depfile: '$out.d',
    deps: 'gcc',
    command: '$cxx -MMD -MF $out.d $cflags $cflags_cc -c $in -o $out',
    description: 'CXX $out'
  });

  let useCxx = false;
  const ninjas = this.ninjas;
  const ninjaList = this.targetList.map((target, index) => {
    const ninja = new Ninja({
      index: index,
      outDir: this.configDir,
      target: target,
      targetDict: this.targetDicts[target].configurations[this.config],
      ninjas: ninjas,
      config: this.config
    });
    ninjas[target] = ninja;
    return ninja;
  });

  const ninjaFiles = ninjaList.map((ninja) => {
    const res = ninja.generate();
    useCxx = useCxx || ninja.useCxx;
    return path.relative(this.configDir, res);
  });

  // TODO(indutny): windows
  main.rule('link', {
    command: `$${useCxx ? 'ldxx' : 'ld'} $ldflags` +
             `${useCxx ? '$ldflags_cc $cflags_cc' : '$ldflags_c $cflags_c'} ` +
             (process.platform === 'darwin' ?
                 '$in ' :
                 `-Wl,--start-group $in -Wl,--end-group `) +
             `$cflags -o $out $solibs $libs`,
    pool: 'link_pool',
    description: 'LINK $out'
  });

  main.rule('alink', {
    command: 'rm -rf $out && $ar rcs $arflags $out $in',
    description: 'ALINK $out'
  });

  main.sectionEnd('rules');

  main.section('targets');
  ninjaFiles.forEach(file => main.subninja(file));
  main.sectionEnd('targets');
};

NinjaMain.prototype.defaults = function defaults() {
  const main = this.n;
  const ninjas = this.ninjas;

  main.section('defaults');
  const defaults = new Set();

  function populateDefaults(ninja) {
    const out = ninja.output();
    if (!Array.isArray(out))
      defaults.add(out);
    else
      out.forEach(o => defaults.add(o));
  }

  this.params.build_files.forEach((buildFile) => {
    this.targetList.forEach((target) => {
      const [ targetBuildFile, _1, _2 ] =
          gyp.common.parseQualifiedTarget(target);
      if (targetBuildFile !== buildFile)
        return;

      populateDefaults(ninjas[target]);
      (this.targetDicts[target].dependencies || []).forEach((dep) => {
        populateDefaults(ninjas[dep]);
      });
    });
  });

  main.def('all', Array.from(defaults).sort());
  main.sectionEnd('defaults');

  main.finalize();
}

exports.generateOutput = function generateOutput(targetList, targetDicts, data,
                                                 params) {
  if (targetList.length === 0)
    throw new Error('No targets to build!');

  const configs = Object.keys(targetDicts[targetList[0]].configurations);

  configs.forEach((config) => {
    const main = new NinjaMain(targetList, targetDicts, data, params, config);
    main.generate();
  });
};

exports.performBuild = function performBuild() {
  throw new Error('Not implemented');
};
