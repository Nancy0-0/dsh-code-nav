import test from 'node:test'
import assert from 'node:assert/strict'
import { scanSource, buildIndex, resolveName, maskNoise, KIND_DEFINITION, KIND_WRAPPER } from '../lib/resolver.js'

const CPP = [
  '#include <cstdio>',
  '// runSpecialSession( 在注释里，不该算定义',
  'static int helper(int x) {',
  '  return x + 1;',
  '}',
  'void runSpecialSession(double v) {',
  '  int y = helper(3);',
  '  printf("runSpecialSession(%f)", v);',
  '}',
  'int main() {',
  '  runSpecialSession(1.0);',
  '  return 0;',
  '}',
].join('\n')

test('注释、字符串、Python 三引号都被屏蔽', () => {
  const masked = maskNoise('// helper(1)', { block: false, triple: '' }, 'cpp')
  assert.equal(masked.includes('helper'), false)
  const masked2 = maskNoise('const char* s = "helper(2)";', { block: false, triple: '' }, 'cpp')
  assert.equal(masked2.includes('helper(2)'), false)
  const py = ['"""', 'def phantom():', '  pass', '"""'].join('\n')
  const sites = scanSource(py, 'python', 'a.py')
  assert.equal(sites.filter(s => s.kind === KIND_DEFINITION).length, 0)
})

test('定义识别：helper / runSpecialSession / main', () => {
  const sites = scanSource(CPP, 'cpp', 'src/a.cpp')
  const defs = sites.filter(s => s.kind === KIND_DEFINITION).map(s => s.name)
  assert.deepEqual(defs, ['helper', 'runSpecialSession', 'main'])
})

test('L1：同名唯一函数定义直接命中定义行', () => {
  const index = buildIndex(scanSource(CPP, 'cpp', 'src/a.cpp'))
  const hit = resolveName('runSpecialSession', index, [])
  assert.equal(hit.via, KIND_DEFINITION)
  assert.equal(hit.line, 6)
})

test('L2：printf 无定义 → 回退到包住调用点的函数', () => {
  const index = buildIndex(scanSource(CPP, 'cpp', 'src/a.cpp'))
  const hit = resolveName('printf', index, [])
  assert.equal(hit.via, KIND_WRAPPER)
  assert.equal(hit.line, 6)
})

test('wrapper 必须真的包住调用点（缩进退出的调用不算）', () => {
  const src = ['def previous():', '    pass', '', 'missing()', ''].join('\n')
  const index = buildIndex(scanSource(src, 'python', 'a.py'))
  const hit = resolveName('missing', index, [])
  assert.equal(hit === null || hit.via !== KIND_WRAPPER, true)
})

test('Allman 花括号风格：调用点仍在函数体内', () => {
  const src = ['void caller()', '{', '  externalCall();', '}'].join('\n')
  const index = buildIndex(scanSource(src, 'cpp', 'a.cpp'))
  const hit = resolveName('externalCall', index, [])
  assert.equal(hit.via, KIND_WRAPPER)
  assert.equal(hit.line, 1)
})

test('单行空函数体不吞掉后面的函数', () => {
  const src = ['function caller() {}', 'outside();', 'function later() {', ' inside();', '}'].join('\n')
  const index = buildIndex(scanSource(src, 'js', 'a.js'))
  const hit = resolveName('outside', index, [])
  assert.notEqual(hit.via, KIND_WRAPPER)
})

test('Python 文档字符串内列 0 文本不提前结束函数体', () => {
  const src = ['def outer():', '    """doc', 'text at column zero', '"""', '    inner()', ''].join('\n')
  const index = buildIndex(scanSource(src, 'python', 'a.py'))
  const hit = resolveName('inner', index, [])
  assert.equal(hit.via, KIND_WRAPPER)
  assert.equal(hit.line, 1)
})

test('C++ 限定名与末段名都能解析', () => {
  const src = ['void Foo::bar() {', '  baz();', '}'].join('\n')
  const index = buildIndex(scanSource(src, 'cpp', 'a.cpp'))
  assert.equal(resolveName('Foo::bar', index, []).line, 1)
  assert.equal(resolveName('bar', index, []).line, 1)
})

test('大量调用点不挤掉定义', () => {
  const calls = Array.from({ length: 60 }, (_, i) => 'void target(); int v' + i + ' = target();').join('\n')
  const src = calls + '\nvoid target() {}\n'
  const index = buildIndex(scanSource(src, 'cpp', 'a.cpp'))
  const hit = resolveName('target', index, [])
  assert.equal(hit.via, KIND_DEFINITION)
  assert.equal(hit.line, 61)
})

test('确定性排序（路径字典序 + 行号）', () => {
  const a = scanSource('void zeta() {}\n', 'cpp', 'b.cpp')
  const b = scanSource('void zeta() {}\n', 'cpp', 'a.cpp')
  const index = buildIndex([...a, ...b])
  const first = resolveName('zeta', index, [])
  assert.equal(first.path, 'a.cpp')
  assert.deepEqual(first, resolveName('zeta', index, []))
})

test('无命中返回 null', () => {
  const index = buildIndex(scanSource(CPP, 'cpp', 'src/a.cpp'))
  assert.equal(resolveName('definitelyMissingSymbol', index, []), null)
})
