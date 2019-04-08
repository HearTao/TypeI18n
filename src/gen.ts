import * as yaml from 'yaml'
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'
import * as prettier from 'prettier'
import * as prettierConfig from './prettier.json'

import { YamlNode, RecordTypeDescriptor, Target, Context } from './types'
import {
  isStringType,
  isCallType,
  arrayEq,
  isRecordType,
  isParamArgType,
  first,
  getCurrentPath,
  inPathContext,
  isMissingRecordTypeDescriptor
} from './utils'
import {
  genRecordType,
  genAlias,
  genResourceExport,
  genProvider,
  genProviderExport,
  matchCallBody
} from './helper'
import {
  createMissingRecordTypeDescriptor,
  createStringTypeDescriptor,
  createCallTypeDescriptor,
  createRecordTypeDescriptor
} from './factory'

function toTypeNode(node: YamlNode, context: Context): RecordTypeDescriptor {
  const record = createRecordTypeDescriptor({})

  Object.entries(node).forEach(([key, value]) => {
    switch (typeof value) {
      case 'number':
        value = value.toString()
      case 'string':
        const args = matchCallBody(value)
        if (!args) {
          record.value[key] = createStringTypeDescriptor(value)
        } else {
          record.value[key] = createCallTypeDescriptor(args)
        }
        break
      case 'object':
        record.value[key] = inPathContext(context, key, ctx =>
          toTypeNode(value, ctx)
        )
        break
      default:
        context.errors.push(`unexpected value: [${key}, ${value}]`)
        break
    }
  })

  return record
}

function merge(
  target: RecordTypeDescriptor,
  source: RecordTypeDescriptor,
  context: Context
): RecordTypeDescriptor {
  Object.entries(target.value).forEach(([key, value]) => {
    if (!(key in source.value)) {
      context.errors.push(`${key} is missing in ${getCurrentPath(context)}`)
      return
    }
    if (source.value[key].kind !== value.kind) {
      context.errors.push(
        `${getCurrentPath(context)}.${key} is not correctly type, expected: ${
          value.kind
        }, actually: ${source.value[key].kind}`
      )
      return
    }
  })

  Object.entries(source.value).forEach(([key, value]) => {
    if (!(key in target.value)) {
      if (isMissingRecordTypeDescriptor(target)) {
        target.value[key] = source.value[key]
      } else {
        context.errors.push(`${key} is missing in ${getCurrentPath(context)}`)
      }
      return
    }

    const targetValue = target.value[key]
    if (isStringType(targetValue) && isStringType(value)) {
    } else if (isCallType(targetValue) && isCallType(value)) {
      if (
        !arrayEq(
          targetValue.body.filter(isParamArgType),
          value.body.filter(isParamArgType),
          x => x.name
        )
      ) {
        context.errors.push(
          `${getCurrentPath(context)}.${key} has different type: [${
            targetValue.body
          }, ${value.body}]`
        )
        return
      }
    } else if (isRecordType(targetValue) && isRecordType(value)) {
      inPathContext(context, key, ctx => merge(targetValue, value, ctx))
    } else {
      context.errors.push(
        `${getCurrentPath(context)}.${key} is not correctly type, expected: ${
          targetValue.kind
        }, actually: ${value.kind}`
      )
      return
    }
  })

  if (isMissingRecordTypeDescriptor(target)) {
    delete target.missing
  }

  return target
}

function print(nodes: ts.Node[]) {
  return ts
    .createPrinter()
    .printList(
      ts.ListFormat.MultiLine,
      ts.createNodeArray(nodes),
      ts.createSourceFile('', '', ts.ScriptTarget.Latest)
    )
}

function genExportDefault(
  target: Target,
  typeAlias: ts.TypeAliasDeclaration,
  typeNodes: [string, RecordTypeDescriptor][],
  defaultLang: string
) {
  switch (target) {
    case Target.resource:
      return [genResourceExport(typeAlias.name, typeNodes)]
    case Target.provider:
      return [
        genProvider(),
        ...genProviderExport(typeAlias.name, typeNodes, defaultLang)
      ]
  }
}

export function gen(filenames: string[], target: Target = Target.resource) {
  const context: Context = { errors: [], paths: [] }

  const files = filenames.map(
    file =>
      [path.basename(file, '.yaml'), fs.readFileSync(file).toString()] as [
        string,
        string
      ]
  )
  const typeNodes = files
    .map(([f, x]) => [f, yaml.parse(x) as YamlNode])
    .map(
      ([f, x]) => [f, toTypeNode(x, context)] as [string, RecordTypeDescriptor]
    )

  const merged = typeNodes.reduce<RecordTypeDescriptor>(
    (prev, [_, next]) => merge(prev, next, context),
    createMissingRecordTypeDescriptor()
  )

  if (context.errors.length) {
    throw new Error(context.errors.join('\n'))
  }

  const rootType = 'RootType'
  const typeAlias = genAlias(rootType, genRecordType(merged))
  const exportDefault = genExportDefault(
    target,
    typeAlias,
    typeNodes,
    first(files)[0]
  )

  const code = prettier.format(
    print([typeAlias, ...exportDefault]),
    prettierConfig as prettier.Options
  )
  return code
}
