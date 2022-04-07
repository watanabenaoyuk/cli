const fs = require('fs')
const { promisify } = require('util')
const execAsync = promisify(require('child_process').exec)
const { join, resolve } = require('path')
const t = require('tap')
const rimraf = promisify(require('rimraf'))

const cwd = process.cwd()
const npmDir = process.env.SMOKE_TEST_NPM_DIR || resolve(__dirname, '..', '..')

const normalizePath = path => path.replace(/[A-Z]:/, '').replace(/\\/g, '/')

t.cleanSnapshot = s =>
  s
    .split(normalizePath(npmDir))
    .join('{CWD}')
    .split(normalizePath(cwd))
    .join('{CWD}')
    .split(registry)
    .join('https://registry.npmjs.org/')
    .split(normalizePath(process.execPath))
    .join('node')
    .split(npmDir)
    .join('{CWD}')
    .split(cwd)
    .join('{CWD}')
    .replace(/\\+/g, '/')
    .replace(/\r\n/g, '\n')
    .replace(/ \(in a browser\)/g, '')
    .replace(/^npm@.* /gm, 'npm ')
    .replace(/^.*debug-[0-9]+.log$/gm, '')

// setup fixtures
const path = t.testdir({
  '.npmrc': '',
  cache: {},
  project: {},
  bin: {},
})
const localPrefix = resolve(path, 'project')
const userconfigLocation = resolve(path, '.npmrc')
const npmLocation = join(npmDir, 'bin', 'npm-cli.js')
const cacheLocation = resolve(path, 'cache')
const binLocation = resolve(path, 'bin')

const exec = async (cmd, ...extraOpts) => {
  const opts = [
    `--registry=${registry}`,
    `--cache="${cacheLocation}"`,
    `--userconfig="${userconfigLocation}"`,
    '--no-audit',
    '--no-update-notifier',
    '--loglevel=silly',
    ...extraOpts,
  ]
  // XXX: not sure why outdated fails with no-workspaces but works without it
  if (!extraOpts.includes('--workspaces') && cmd !== 'outdated') {
    // This is required so we dont detect any workspace roots above the testdir
    opts.push('--no-workspaces')
  }
  const res = await execAsync(`"${process.execPath}" "${npmLocation}" ${cmd} ${opts.join(' ')}`, {
    cwd: localPrefix,
    env: {
      HOME: path,
      PATH: `${process.env.PATH}:${binLocation}`,
    },
  })
  if (res.stderr && process.env.CI) {
    console.error(res.stderr)
  }
  return String(res.stdout)
}

// setup server
const { start, stop, registry } = require('../lib/server.js')
t.before(start)
t.afterEach((t) => {
  const updateExists = fs.existsSync(join(cacheLocation, '_update-notifier-last-checked'))
  t.equal(updateExists, false)
})
t.teardown(stop)

const readFile = filename => String(fs.readFileSync(resolve(localPrefix, filename)))

// this test must come first, its package.json will be destroyed and the one
// created in the next test (npm init) will create a new one that must be
// present for later tests
t.test('npm install sends correct user-agent', async t => {
  const pkgPath = join(localPrefix, 'package.json')
  const pkgContent = JSON.stringify({
    name: 'smoke-test-workspaces',
    workspaces: ['packages/*'],
  })
  fs.writeFileSync(pkgPath, pkgContent, { encoding: 'utf8' })

  const wsRoot = join(localPrefix, 'packages')
  fs.mkdirSync(wsRoot)

  const wsPath = join(wsRoot, 'foo')
  fs.mkdirSync(wsPath)

  const wsPkgPath = join(wsPath, 'package.json')
  const wsContent = JSON.stringify({
    name: 'foo',
  })
  fs.writeFileSync(wsPkgPath, wsContent, { encoding: 'utf8' })
  t.teardown(async () => {
    await rimraf(`${localPrefix}/*`)
  })

  await t.rejects(
    exec('install fail_reflect_user_agent'),
    {
      stderr: /workspaces\/false/,
    },
    'workspaces/false is present in output'
  )

  await t.rejects(
    exec('install fail_reflect_user_agent', '--workspaces'),
    {
      stderr: /workspaces\/true/,
    },
    'workspaces/true is present in output'
  )
})

t.test('npm init', async t => {
  const cmdRes = await exec('init -y')

  t.matchSnapshot(cmdRes, 'should have successful npm init result')
  const pkg = JSON.parse(fs.readFileSync(resolve(localPrefix, 'package.json')))
  t.equal(pkg.name, 'project', 'should have expected generated name')
  t.equal(pkg.version, '1.0.0', 'should have expected generated version')
})

t.test('npm (no args)', async t => {
  const err = await exec('', '--loglevel=notice').catch(e => e)

  t.equal(err.code, 1, 'should exit with error code')
  t.equal(err.stderr, '', 'should have no stderr output')
  t.matchSnapshot(String(err.stdout), 'should have expected no args output')
})

t.test('npm install prodDep@version', async t => {
  const cmdRes = await exec('install abbrev@1.0.4')

  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected install reify output')
  t.matchSnapshot(readFile('package.json'), 'should have expected package.json result')
  t.matchSnapshot(readFile('package-lock.json'), 'should have expected lockfile result')
})

t.test('npm install dev dep', async t => {
  const cmdRes = await exec('install -D promise-all-reject-late')

  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected dev dep added reify output')
  t.matchSnapshot(
    readFile('package.json'),
    'should have expected dev dep added package.json result'
  )
  t.matchSnapshot(
    readFile('package-lock.json'),
    'should have expected dev dep added lockfile result'
  )
})

t.test('npm ls', async t => {
  const cmdRes = await exec('ls')

  t.matchSnapshot(cmdRes, 'should have expected ls output')
})

t.test('npm fund', async t => {
  const cmdRes = await exec('fund')

  t.matchSnapshot(cmdRes, 'should have expected fund output')
})

t.test('npm explain', async t => {
  const cmdRes = await exec('explain abbrev')

  t.matchSnapshot(cmdRes, 'should have expected explain output')
})

t.test('npm diff', async t => {
  const cmdRes = await exec('diff --diff=abbrev@1.0.4 --diff=abbrev@1.1.1')

  t.matchSnapshot(cmdRes, 'should have expected diff output')
})

t.test('npm outdated', async t => {
  const err = await exec('outdated').catch(e => e)

  t.equal(err.code, 1, 'should exit with error code')
  t.not(err.stderr, '', 'should have stderr output')
  t.matchSnapshot(String(err.stdout), 'should have expected outdated output')
})

t.test('npm set-script', async t => {
  const cmdRes = await exec(`set-script "hello" "echo Hello"`)

  t.matchSnapshot(cmdRes, 'should have expected set-script output')
  t.matchSnapshot(
    readFile('package.json'),
    'should have expected script added package.json result'
  )
})

t.test('npm run-script', async t => {
  const cmdRes = await exec('run hello')

  t.matchSnapshot(cmdRes, 'should have expected run-script output')
})

t.test('npm prefix', async t => {
  const cmdRes = await exec('prefix')

  t.matchSnapshot(cmdRes, 'should have expected prefix output')
})

t.test('npm view', async t => {
  const cmdRes = await exec('view abbrev@1.0.4')

  t.matchSnapshot(cmdRes, 'should have expected view output')
})

t.test('npm update dep', async t => {
  const cmdRes = await exec('update abbrev')

  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected update reify output')
  t.matchSnapshot(readFile('package.json'), 'should have expected update package.json result')
  t.matchSnapshot(readFile('package-lock.json'), 'should have expected update lockfile result')
})

t.test('npm uninstall', async t => {
  const cmdRes = await exec('uninstall promise-all-reject-late')

  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected uninstall reify output')
  t.matchSnapshot(readFile('package.json'), 'should have expected uninstall package.json result')
  t.matchSnapshot(readFile('package-lock.json'), 'should have expected uninstall lockfile result')
})

t.test('npm pkg', async t => {
  let cmdRes = await exec('pkg get license')
  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected pkg get output')

  cmdRes = await exec('pkg set tap[test-env][0]=LC_ALL=sk')
  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected pkg set output')

  t.matchSnapshot(
    readFile('package.json'),
    'should have expected npm pkg set modified package.json result'
  )

  cmdRes = await exec('pkg get')
  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should print package.json contents')

  cmdRes = await exec('pkg delete tap')
  t.matchSnapshot(cmdRes.replace(/in.*s/, ''), 'should have expected pkg delete output')

  t.matchSnapshot(
    readFile('package.json'),
    'should have expected npm pkg delete modified package.json result'
  )
})

t.test('npm update --no-save --no-package-lock', async t => {
  // setup, manually reset dep value
  await exec(`pkg set "dependencies.abbrev==1.0.4"`)
  await exec(`install`)
  await exec(`pkg set "dependencies.abbrev=^1.0.4"`)

  await exec('update --no-save --no-package-lock')

  t.equal(
    JSON.parse(readFile('package.json')).dependencies.abbrev,
    '^1.0.4',
    'should have expected update --no-save --no-package-lock package.json result'
  )
  t.equal(
    JSON.parse(readFile('package-lock.json')).packages['node_modules/abbrev'].version,
    '1.0.4',
    'should have expected update --no-save --no-package-lock lockfile result'
  )
})

t.test('npm update --no-save', async t => {
  await exec('update --no-save')

  t.equal(
    JSON.parse(readFile('package.json')).dependencies.abbrev,
    '^1.0.4',
    'should have expected update --no-save package.json result'
  )
  t.equal(
    JSON.parse(readFile('package-lock.json')).packages['node_modules/abbrev'].version,
    '1.1.1',
    'should have expected update --no-save lockfile result'
  )
})

t.test('npm update --save', async t => {
  await exec('update --save')

  t.equal(
    JSON.parse(readFile('package.json')).dependencies.abbrev,
    '^1.1.1',
    'should have expected update --save package.json result'
  )
  t.equal(
    JSON.parse(readFile('package-lock.json')).packages['node_modules/abbrev'].version,
    '1.1.1',
    'should have expected update --save lockfile result'
  )
})

t.test('npm ci', async t => {
  await exec(`uninstall abbrev`)
  await exec(`install abbrev@1.0.4 --save-exact`)

  t.equal(
    JSON.parse(readFile('package-lock.json')).packages['node_modules/abbrev'].version,
    '1.0.4',
    'should have stored exact installed version'
  )

  await exec(`pkg set "dependencies.abbrev=^1.1.1"`)

  const err = await exec('ci', '--loglevel=error').catch(e => e)
  t.equal(err.code, 1)
  t.matchSnapshot(err.stderr, 'should throw mismatch deps in lock file error')
})
