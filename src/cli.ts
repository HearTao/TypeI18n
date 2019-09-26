import * as fs from 'fs'
import * as path from 'path'
import * as yargs from 'yargs'
import * as getStdin from 'get-stdin'
import { gen, Target } from './'
import { highlight } from 'cardinal'
import { watch as chokidar } from 'chokidar'
import * as osLocale from 'os-locale'
import i18n, { Language } from './locales'
import { NamedValue, YamlNode } from './types'
import * as yaml from 'js-yaml'
import * as prettier from 'prettier'
import * as prettierOptions from './prettier.json'

function mapLocaleToLanguage(l: string): Language {
  switch (l) {
    case 'en_US':
      return 'en-US'
    case 'zh_CN':
      return 'zh-CN'
    default:
      return 'en-US'
  }
}

function handler(_data?: string) {
  return function handler1(argv: yargs.Arguments): void {
    const input = argv['input'] as string
    const output = argv['output'] as string
    const color = argv['color'] as boolean
    const target = argv['target'] as Target
    const watch = argv[`watch`] as boolean
    const lazy = argv[`lazy`] as boolean
    const defaultLanguage = argv[`default`] as string

    const prettierConfig = prettierOptions as prettier.Options

    i18n.setLanguage(mapLocaleToLanguage(osLocale.sync()))
    const files = getFiles(input)

    if (watch) {
      run(files, false)
      const cache = createCache(files)
      console.log(`Waiting for file change\n`)
      chokidar(`./**/*.yaml`, { ignored: /(^|[\/\\])\../, cwd: input })
        .on('change', file => {
          console.log(`${file} changed, processing...`)
          const fileName = path.basename(file, path.extname(file))
          const content = fs.readFileSync(path.join(input, file), 'utf-8')
          if('' !== content.trim()) {
            cache.set(fileName, yaml.safeLoad(content))
          } else {
            cache.delete(fileName)
          }
          run(exportCache(cache), false)
          console.log(`Waiting for file change\n`)
        })
        .on('unlink', file => {
          console.log(`${file} removed, processing...`)
          cache.delete(path.basename(file, path.extname(file)))
          run(exportCache(cache), false)
          console.log(`Waiting for file change\n`)
        })
    } else {
      run(files)
    }

    function run(files: NamedValue<YamlNode>[], isThrow: boolean = true): void {
      try {
        if (lazy) {
          generateLazy(files)
        } else {
          generate(files)
        }
      } catch (e) {
        if(isThrow) throw new Error(e)
        console.log(e.message)
        // console.error(e)
      }
    }

    function generate(files: NamedValue<YamlNode>[]) {
      const result = gen(files, target)

      if (!output) {
        console.log(color ? highlight(result) : result + '\n')
        return
      }

      const filepath: string = path.resolve(output)

      fs.writeFileSync(path.join(filepath, 'index.ts'), prettier.format(result, prettierConfig), 'utf8')
      console.log(`Done at ${filepath}`)
    }

    function generateLazy(files: NamedValue<YamlNode>[]) {
      const [index, others] = gen(files, target, true, defaultLanguage)

      if (!output) {
        console.log(
          `${'<'.padEnd(40, '=')} index.ts ${'>'.padStart(40, '=')}\n`
        )
        console.log(color ? highlight(index) : index + '\n')

        others.forEach(([file, code]) => {
          console.log(
            `${'<'.padEnd(40, '=')} ${file}.ts ${'>'.padStart(40, '=')}\n`
          )
          console.log(color ? highlight(code) : code + '\n')
        })
        return
      }

      const filepath: string = path.resolve(output)

      fs.writeFileSync(path.join(filepath, 'index.ts'), prettier.format(index, prettierConfig), 'utf8')
      others.forEach(([file, code]) => {
        fs.writeFileSync(path.join(filepath, `${file}.ts`), prettier.format(code, prettierConfig), 'utf8')
      })

      console.log(`Done at ${filepath}`)
    }
  }
}

function getFiles(input: string): NamedValue<YamlNode>[] {
  return fs
    .readdirSync(input)
    .filter(x => x.endsWith('.yaml'))
    .map(x => path.join(input, x))
    .map(x => ({
      name: path.basename(x, '.yaml'),
      value: yaml.safeLoad(fs.readFileSync(x, 'utf-8'))
    }))
}

function createCache(files: NamedValue<YamlNode>[]): Map<string, string> {
  const cache = new Map
  files.forEach(({ name, value }) => {
    cache.set(name, value)
  })
  return cache
}

function exportCache(cache: Map<string, string>): NamedValue<YamlNode>[] {
  const acc: NamedValue<YamlNode>[] = []
  cache.forEach((value, name) => {
    acc.push({ name, value })
  })
  return acc
}

function handleInitial(argv: yargs.Arguments): void {
  const dir = argv['dir'] as string
  const locales = argv['locales'] as string[]
  const dirPath: string = path.isAbsolute(dir)
    ? dir
    : path.resolve(process.cwd(), dir)
  fs.mkdirSync(dirPath, { recursive: true })
  const out: string[] = [`|- ${dir}`]
  locales.forEach(file => {
    const filePath: string = path.resolve(dirPath, file + '.yaml')
    if (fs.existsSync(filePath)) {
      console.warn(`Skipped, ${filePath} was alread exists`)
    } else {
      fs.writeFileSync(path.resolve(dirPath, file + '.yaml'), '', 'utf-8')
      out.push(`  |- ${file}.yaml`)
    }
  })

  console.log('\n', out.join('\n'))
}

/** @internal */
export default function main(args: string[]) {
  getStdin().then(data => {
    const isReadData: boolean = '' !== data
    yargs
      .strict()
      .command({
        command: `$0 ${isReadData ? '' : '<input> '}[options]`,
        describe: 'Generate i18n files',
        handler: handler(isReadData ? data : undefined),
        builder: (yargs: yargs.Argv): yargs.Argv => {
          if (isReadData) return yargs
          return yargs.positional('input', {
            describe: 'input file path',
            type: 'string',
            normalize: true
          })
        }
      })
      .command({
        command: `init [locales...]`,
        describe: `initial a local file`,
        handler: handleInitial,
        builder: (yargs: yargs.Argv): yargs.Argv => {
          return yargs
            .positional('locales', {
              describe: 'default locales, default "en"',
              type: 'string'
            })
            .options('d', {
              alias: 'dir',
              describe: 'Locales directory',
              type: 'string',
              default: `locales`,
              normalize: true
            })
        }
      })
      .option('o', {
        alias: 'output',
        describe: 'Output directory',
        type: 'string',
        requiresArg: true
      })
      .option('color', {
        describe: 'colorful result when print on terminal',
        type: 'boolean',
        default: true
      })
      .option('t', {
        alias: 'target',
        describe: 'Output target',
        type: 'string',
        choices: [Target.resource, Target.provider, Target.type],
        default: Target.provider
      })
      .option('l', {
        alias: 'lazy',
        describe: 'Lazy loading',
        type: 'boolean',
        default: false
      })
      .option('d', {
        alias: 'default',
        describe: 'Default language',
        type: 'string'
      })
      .option(`w`, {
        alias: `watch`,
        describe: `watch file change`,
        type: `boolean`,
        default: false
      })
      .version()
      .alias('v', 'version')
      .showHelpOnFail(true, 'Specify --help for available options')
      .help('h')
      .alias('h', 'help').argv
  })
}
