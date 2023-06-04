import { dump } from 'js-yaml'
import JSZip from 'jszip'
import { omit } from 'lodash'
import { marked } from 'marked'
import { Types } from 'mongoose'
import xss from 'xss'

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { ReturnModelType } from '@typegoose/typegoose'

import { DatabaseService } from '~/processors/database/database.service'
import { AssetService } from '~/processors/helper/helper.asset.service'
import { TextMacroService } from '~/processors/helper/helper.macro.service'
import { InjectModel } from '~/transformers/model.transformer'

import { CategoryModel } from '../category/category.model'
import { NoteModel } from '../note/note.model'
import { PageModel } from '../page/page.model'
import { PostModel } from '../post/post.model'
import { DatatypeDto } from './markdown.dto'
import { MarkdownYAMLProperty } from './markdown.interface'

@Injectable()
export class MarkdownService {
  constructor(
    private readonly assetService: AssetService,

    @InjectModel(CategoryModel)
    private readonly categoryModel: ReturnModelType<typeof CategoryModel>,
    @InjectModel(PostModel)
    private readonly postModel: ReturnModelType<typeof PostModel>,
    @InjectModel(NoteModel)
    private readonly noteModel: ReturnModelType<typeof NoteModel>,
    @InjectModel(PageModel)
    private readonly pageModel: ReturnModelType<typeof PageModel>,

    private readonly databaseService: DatabaseService,

    private readonly macroService: TextMacroService,
  ) {}

  async insertPostsToDb(data: DatatypeDto[]) {
    let count = 1
    const categoryNameAndId = (await this.categoryModel.find().lean()).map(
      (c) => {
        return { name: c.name, _id: c._id, slug: c.slug }
      },
    )

    const insertOrCreateCategory = async (name?: string) => {
      if (!name) {
        return
      }

      const hasCategory = categoryNameAndId.find(
        (c) => name === c.name || name === c.slug,
      )

      if (!hasCategory) {
        const newCategoryDoc = await this.categoryModel.create({
          name,
          slug: name,
          type: 0,
        })
        categoryNameAndId.push({
          name: newCategoryDoc.name,
          _id: newCategoryDoc._id,
          slug: newCategoryDoc.slug,
        })

        await newCategoryDoc.save()
        return newCategoryDoc
      } else {
        return hasCategory
      }
    }
    const genDate = this.genDate
    const models = [] as PostModel[]
    const defaultCategory = await this.categoryModel.findOne()
    if (!defaultCategory) {
      throw new InternalServerErrorException('分类不存在')
    }
    for await (const item of data) {
      if (!item.meta) {
        models.push({
          title: `未命名-${count++}`,
          slug: new Date().getTime(),
          text: item.text,
          ...genDate(item),
          categoryId: new Types.ObjectId(defaultCategory._id),
        } as any as PostModel)
      } else {
        const category = await insertOrCreateCategory(
          item.meta.categories?.shift(),
        )
        models.push({
          title: item.meta.title,
          slug: item.meta.slug || item.meta.title,
          text: item.text,
          ...genDate(item),
          categoryId: category?._id || defaultCategory._id,
        } as PostModel)
      }
    }
    return await this.postModel
      .insertMany(models, { ordered: false })
      .catch((err) => {
        Logger.log('一篇文章导入失败', MarkdownService.name)
      })
  }

  async insertNotesToDb(data: DatatypeDto[]) {
    const models = [] as NoteModel[]
    for await (const item of data) {
      if (!item.meta) {
        models.push({
          title: '未命名记录',
          text: item.text,
          ...this.genDate(item),
        } as NoteModel)
      } else {
        models.push({
          title: item.meta.title,
          text: item.text,
          ...this.genDate(item),
        } as NoteModel)
      }
    }

    return await this.noteModel.create(models)
  }

  private readonly genDate = (item: DatatypeDto) => {
    const { meta } = item
    if (!meta) {
      return {
        created: new Date(),
        modified: new Date(),
      }
    }
    const { date, updated } = meta
    return {
      created: date ? new Date(date) : new Date(),
      modified: updated
        ? new Date(updated)
        : date
        ? new Date(date)
        : new Date(),
    }
  }

  async extractAllArticle() {
    return {
      posts: await this.postModel.find().populate('category'),
      notes: await this.noteModel.find().lean(),
      pages: await this.pageModel.find().lean(),
    }
  }

  async generateArchive({
    documents,
    options = {},
  }: {
    documents: MarkdownYAMLProperty[]
    options: { slug?: boolean }
  }) {
    const zip = new JSZip()

    for (const document of documents) {
      zip.file(
        (options.slug ? document.meta.slug : document.meta.title)
          .concat('.md')
          .replace(/\//g, '-'),
        document.text,
      )
    }
    return zip
  }

  markdownBuilder(
    property: MarkdownYAMLProperty,
    includeYAMLHeader?: boolean,
    showHeader?: boolean,
  ) {
    const {
      meta: { created, modified, title },
      text,
    } = property
    if (!includeYAMLHeader) {
      return `${showHeader ? `# ${title}\n\n` : ''}${text.trim()}`
    }
    const header = {
      date: created,
      updated: modified,
      title,
      ...omit(property.meta, ['created', 'modified', 'title']),
    }
    const toYaml = dump(header, { skipInvalid: true })
    const res = `
---
${toYaml.trim()}
---

${showHeader ? `# ${title}\n\n` : ''}
${text.trim()}
`.trim()

    return res
  }

  /**
   * 根据文章 Id 渲染一篇文章
   * @param id
   * @returns
   */
  async renderArticle(id: string) {
    const result = await this.databaseService.findGlobalById(id)

    if (!result || result.type === 'Recently')
      throw new BadRequestException('文档不存在')

    return {
      html: this.renderMarkdownContent(
        await this.macroService.replaceTextMacro(
          result.document.text,
          result.document,
        ),
      ),
      ...result,
      document: result.document,
    }
  }

  /**
   * 渲染 Markdown 文本输出 html
   * @param text
   * @returns
   */
  public renderMarkdownContent(text: string) {
    marked.use({
      gfm: true,
      sanitize: false,
      extensions: [
        {
          level: 'inline',
          name: 'spoiler',
          start(src) {
            return src.match(/\|/)?.index ?? -1
          },
          renderer(token) {
            // @ts-ignore
            return `<span class="spoiler" style="filter: invert(25%)">${this.parser.parseInline(
              token.text,
            )}\n</span>`
          },
          tokenizer(src, tokens) {
            const rule = /^\|\|([\s\S]+?)\|\|(?!\|)/
            const match = rule.exec(src)
            if (match) {
              return {
                type: 'spoiler',
                raw: match[0],
                // @ts-ignore
                text: this.lexer.inlineTokens(match[1].trim()),
              }
            }
          },
          childTokens: ['text'],
        },
        {
          level: 'inline',
          name: 'katex',
          start(src) {
            return src.match(/\$/)?.index ?? -1
          },
          renderer(token) {
            return `<span class="katex-render">${token.text}</span>`
          },
          tokenizer(src) {
            const rule = /^\$([\s\S]+?)\$(?!\$)/
            const match = rule.exec(src)
            if (match) {
              return {
                type: 'katex',
                raw: match[0],
                // @ts-ignore
                text: match[1].trim(),
              }
            }
          },
        },
        {
          level: 'inline',
          name: 'mention',
          start(src) {
            return src.match(/\(/)?.index ?? -1
          },
          renderer(token) {
            const { groups } = token
            const { prefix, name: username } = groups

            const prefixToUrlMap = {
              GH: 'https://github.com/',
              TW: 'https://twitter.com/',
              TG: 'https://t.me/',
            }
            const urlPrefix = prefixToUrlMap[prefix]
            return `<a target="_blank" class="mention" rel="noreferrer nofollow" href="${urlPrefix}${username}">${username}</a>`
          },
          tokenizer(src) {
            const rule =
              /^\{((?<prefix>(GH)|(TW)|(TG))@(?<name>\w+\b))\}\s?(?!\[.*?\])/
            const match = rule.exec(src)
            if (match) {
              const { groups } = match
              return {
                type: 'mention',
                raw: match[0],
                groups,
              }
            }
          },
          childTokens: ['text'],
        },
        {
          level: 'block',
          name: 'container',
          start(src) {
            return src.indexOf(':::')
          },
          renderer(token) {
            const { groups, images, paragraph } = token
            const { params, name } = groups

            switch (name) {
              case 'gallery':
                return `<div class="container">${this.parser.parseInline(
                  images,
                )}</div>`
              case 'banner':
                return `<div class="container ${name} ${params}">${this.parser.parse(
                  paragraph,
                )}</div>`
            }
            return ''
          },
          tokenizer(src) {
            const shouldCatchContainerName = [
              'gallery',
              'banner',
              /* 'carousel', */
            ].join('|')
            const match = new RegExp(
              `^\\s*::: *(?<name>(${shouldCatchContainerName})) *({(?<params>(.*?))})? *\n(?<content>[\\s\\S]+?)\\s*::: *(?:\n *)+\n?`,
            ).exec(src)
            if (match) {
              const { groups } = match
              return {
                type: 'container',
                raw: match[0],
                groups,

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                images: this.lexer.inlineTokens(groups!.content),
                // @ts-expect-error
                paragraph: this.lexer.blockTokens(groups.content),
              }
            }
          },
          childTokens: ['paragraph', 'image'],
        },
      ],

      renderer: {
        image(src, title, _alt) {
          if (typeof src !== 'string') {
            return ''
          }

          const alt = _alt?.match(/^[!¡]/) ? _alt.replace(/^[¡!]/, '') : ''
          if (!alt) {
            return `<img src="${xss(src)}"/>`
          }
          return `<figure>
          <img src="${xss(src)}"/>
          <figcaption style="text-align: center; margin: 1em auto;">${xss(
            title || alt,
          )}</figcaption></figure>`
        },

        code(code, lang) {
          if (lang == 'mermaid') {
            return `<pre class="mermaid">${code}</pre>`
          } else {
            return `<pre><code class="language-${lang}">${xss(
              code,
            )}</code></pre>`
          }
        },
      },
    })

    return marked(text)
  }

  async getRenderedMarkdownHtmlStructure(
    html: string,
    title: string,
    theme = 'newsprint',
  ) {
    const style = await this.assetService.getAsset('/markdown/markdown.css', {
      encoding: 'utf8',
    })

    const themeStyleSheet = await this.assetService.getAsset(
      `/markdown/theme/${theme}.css`,
      { encoding: 'utf-8' },
    )
    return {
      body: [`<article><h1>${title}</h1>${html}</article>`],
      extraScripts: [
        '<script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/mermaid/8.9.0/mermaid.min.js"></script>',
        '<script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/prism/1.23.0/components/prism-core.min.js"></script>',
        '<script src="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/prism/1.23.0/plugins/autoloader/prism-autoloader.min.js"></script>',
        '<script src="https://lf3-cdn-tos.bytecdntp.com/cdn/expire-1-M/prism/1.23.0/plugins/line-numbers/prism-line-numbers.min.js"></script>',
        // '<script src="https://cdn.jsdelivr.net/npm/prismjs@1.24.1/plugins/show-language/prism-show-language.min.js" defer></script>',
        // '<script src="https://cdn.jsdelivr.net/npm/prismjs@1.24.1/plugins/normalize-whitespace/prism-normalize-whitespace.min.js" defer></script>',
        // '<script src="https://cdn.jsdelivr.net/npm/prismjs@1.24.1/plugins/copy-to-clipboard/prism-copy-to-clipboard.min.js" defer></script>',
        '<script src="https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-M/KaTeX/0.15.2/katex.min.js" async defer></script>',
      ],
      script: [
        `window.mermaid.initialize({theme: 'default',startOnLoad: false})`,
        `window.mermaid.init(undefined, '.mermaid')`,
        `window.onload = () => { document.querySelectorAll('.katex-render').forEach(el => { window.katex.render(el.innerHTML, el, {
          throwOnError: false,
        }) }) }`,
      ],
      link: [
        '<link href="https://cdn.jsdelivr.net/gh/PrismJS/prism-themes@master/themes/prism-one-light.css" rel="stylesheet" />',
        '<link href="https://lf26-cdn-tos.bytecdntp.com/cdn/expire-1-M/prism/1.23.0/plugins/line-numbers/prism-line-numbers.min.css" rel="stylesheet" />',
        // katex
        '<link href="https://lf9-cdn-tos.bytecdntp.com/cdn/expire-1-M/KaTeX/0.15.2/katex.min.css" rel="stylesheet" />',
      ],
      style: [style, themeStyleSheet],
    }
  }

  getMarkdownEjsRenderTemplate() {
    return this.assetService.getAsset('/render/markdown.ejs', {
      encoding: 'utf8',
    }) as Promise<string>
  }

  // getMarkdownRenderTheme() {
  //   return ['newsprint', 'github', 'han', 'gothic'] as const
  // }
}