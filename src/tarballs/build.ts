import {ArchTypes, PlatformTypes} from '@oclif/config'
import * as Errors from '@oclif/errors'
import * as path from 'path'
import * as qq from 'qqjs'

import {log} from '../log'

import {writeBinScripts} from './bin'
import {IConfig, IManifest} from './config'
import {fetchNodeBinary} from './node'

const pack = async (from: string, to: string) => {
  const prevCwd = qq.cwd()
  qq.cd(path.dirname(from))
  await qq.mkdirp(path.dirname(to))
  log(`packing tarball from ${qq.prettifyPaths(from)} to ${qq.prettifyPaths(to)}`)
  await (to.endsWith('gz')
    ? qq.x('tar', ['czf', to, path.basename(from)])
    : qq.x(`tar c ${path.basename(from)} | xz > ${to}`))
  qq.cd(prevCwd)
}

export async function build(c: IConfig, options: {
  platform?: string
  pack?: boolean
} = {}) {
  const {xz, config} = c
  const prevCwd = qq.cwd()
  const packCLI = async () => {
    const stdout = await qq.x.stdout('npm', ['pack', '--unsafe-perm'], {cwd: c.root})
    return path.join(c.root, stdout.split('\n').pop()!)
  }
  const extractCLI = async (tarball: string) => {
    await qq.emptyDir(c.workspace())
    await qq.mv(tarball, c.workspace())
    tarball = path.basename(tarball)
    tarball = qq.join([c.workspace(), tarball])
    qq.cd(c.workspace())
    await qq.x(`tar -xzf ${tarball}`)
    for (let f of await qq.ls('package', {fullpath: true})) await qq.mv(f, '.')
    await qq.rm('package', tarball, 'bin/run.cmd')
  }
  const updatePJSON = async () => {
    qq.cd(c.workspace())
    const pjson = await qq.readJSON('package.json')
    pjson.version = c.version
    pjson.oclif.update = pjson.oclif.update || {}
    pjson.oclif.update.s3 = pjson.oclif.update.s3 || {}
    pjson.oclif.update.s3.bucket = c.s3Config.bucket

    let localDependencies: {[key: string]: string} | undefined
    if (pjson.dependencies) {
      // correct relative file path dependencies
      const dependencies = pjson.dependencies as {[key: string]: string}
      const localPrefix = 'file:'
      localDependencies = Object.entries(dependencies)
        .filter(([, value]) => value.startsWith(localPrefix))
        .map(([dependencyName, filePath]) => ({[dependencyName]: path.relative(c.workspace(), path.resolve(c.root, filePath.substr(localPrefix.length)))}))
        .reduce((prev, curr) => ({...prev, ...curr}), {})
      Object.entries(localDependencies).forEach(([dependencyName, path]) => dependencies[dependencyName] = `${localPrefix}./${path}`)
    }
    await qq.writeJSON('package.json', pjson)
    return {localDependencies}
  }
  const addDependencies = async (options?: {localDependencies: {[key: string]: string} | undefined}) => {
    qq.cd(c.workspace())
    const yarn = await qq.exists.sync([c.root, 'yarn.lock'])
    if (yarn) {
      await qq.cp([c.root, 'yarn.lock'], '.')
      await qq.x('yarn --no-progress --production --non-interactive')
    } else {
      let lockpath = qq.join(c.root, 'package-lock.json')
      if (!await qq.exists(lockpath)) {
        lockpath = qq.join(c.root, 'npm-shrinkwrap.json')
      }
      await qq.cp(lockpath, '.')
      await qq.x('npm install --production')

      // install local dependencies
      if (options && options.localDependencies) {
        for (let depName of Object.keys(options.localDependencies)) {
          const depPath = options.localDependencies[depName]
          await qq.x('npx', ['install-local@^1.0.0', depPath])
        }
      }
    }
  }
  const buildTarget = async (target: {platform: PlatformTypes, arch: ArchTypes}) => {
    const workspace = c.workspace(target)
    const key = config.s3Key('versioned', '.tar.gz', target)
    const base = path.basename(key)
    log(`building target ${base}`)
    await qq.rm(workspace)
    await qq.cp(c.workspace(), workspace)
    await fetchNodeBinary({
      nodeVersion: c.nodeVersion,
      output: path.join(workspace, 'bin', 'node'),
      platform: target.platform,
      arch: target.arch,
      tmp: qq.join(config.root, 'tmp'),
    })
    if (options.pack === false) return
    await pack(workspace, c.dist(key))
    if (xz) await pack(workspace, c.dist(config.s3Key('versioned', '.tar.xz', target)))
    if (!c.updateConfig.s3.host) return
    const rollout = (typeof c.updateConfig.autoupdate === 'object' && c.updateConfig.autoupdate.rollout)
    const manifest: IManifest = {
      rollout: rollout === false ? undefined : rollout,
      version: c.version,
      channel: c.channel,
      baseDir: config.s3Key('baseDir', target),
      gz: config.s3Url(config.s3Key('versioned', '.tar.gz', target)),
      xz: xz ? config.s3Url(config.s3Key('versioned', '.tar.xz', target)) : undefined,
      sha256gz: await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.gz', target))),
      sha256xz: xz ? await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.xz', target))) : undefined,
      node: {
        compatible: config.pjson.engines.node,
        recommended: c.nodeVersion,
      }
    }
    await qq.writeJSON(c.dist(config.s3Key('manifest', target)), manifest)
  }
  const buildBaseTarball = async () => {
    if (options.pack === false) return
    await pack(c.workspace(), c.dist(config.s3Key('versioned', '.tar.gz')))
    if (xz) await pack(c.workspace(), c.dist(config.s3Key('versioned', '.tar.xz')))
    if (!c.updateConfig.s3.host) {
      Errors.warn('No S3 bucket or host configured. CLI will not be able to update.')
      return
    }
    const manifest: IManifest = {
      version: c.version,
      baseDir: config.s3Key('baseDir'),
      channel: config.channel,
      gz: config.s3Url(config.s3Key('versioned', '.tar.gz')),
      xz: config.s3Url(config.s3Key('versioned', '.tar.xz')),
      sha256gz: await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.gz'))),
      sha256xz: xz ? await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.xz'))) : undefined,
      rollout: (typeof c.updateConfig.autoupdate === 'object' && c.updateConfig.autoupdate.rollout) as number,
      node: {
        compatible: config.pjson.engines.node,
        recommended: c.nodeVersion,
      },
    }
    await qq.writeJSON(c.dist(config.s3Key('manifest')), manifest)
  }
  log(`gathering workspace for ${config.bin} to ${c.workspace()}`)
  await extractCLI(await packCLI())
  const packageResults = await updatePJSON()
  await addDependencies(packageResults)
  await writeBinScripts({config, baseWorkspace: c.workspace(), nodeVersion: c.nodeVersion})
  await buildBaseTarball()
  for (let target of c.targets) {
    if (!options.platform || options.platform === target.platform) {
      await buildTarget(target)
    }
  }
  qq.cd(prevCwd)
}
