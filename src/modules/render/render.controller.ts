import dayjs from 'dayjs'
import { render } from 'ejs'
import { isNil } from 'lodash'
import xss from 'xss'

import {
  Body,
  CacheTTL,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common'

import { Auth } from '~/common/decorator/auth.decorator'
import { HttpCache } from '~/common/decorator/cache.decorator'
import { HTTPDecorators } from '~/common/decorator/http.decorator'
import { ApiName } from '~/common/decorator/openapi.decorator'
import { IsMaster } from '~/common/decorator/role.decorator'
import { MongoIdDto } from '~/shared/dto/id.dto'
import { getShortDateTime } from '~/utils'

import { ConfigsService } from '../configs/configs.service'
import { MarkdownPreviewDto } from '../markdown/markdown.dto'
import { MarkdownService } from '../markdown/markdown.service'
import { NoteModel } from '../note/note.model'
import { PageModel } from '../page/page.model'
import { PostModel } from '../post/post.model'

@ApiName
@Controller('/render')
@HTTPDecorators.Bypass
export class RenderEjsController {
  constructor(
    private readonly service: MarkdownService,
    private readonly configs: ConfigsService,
  ) {}

  @Get('/markdown/:id')
  @Header('content-type', 'text/html')
  @CacheTTL(60 * 60)
  async renderArticle(
    @Param() params: MongoIdDto,
    @Query('theme') theme: string,
    @IsMaster() isMaster: boolean,
  ) {
    const { id } = params
    const now = performance.now()
    const [
      { html: markdownMacros, document, type },
      {
        url: { webUrl },
      },
      { name: username },
    ] = await Promise.all([
      this.service.renderArticle(id),
      this.configs.waitForConfigReady(),
      this.configs.getMaster(),
    ])

    if (!isMaster) {
      if (
        ('hide' in document && document.hide) ||
        ('password' in document && !isNil(document.password))
      ) {
        throw new ForbiddenException('该文章已隐藏或加密')
      }
    }

    const relativePath = (() => {
      switch (type.toLowerCase()) {
        case 'post':
          return `/posts/${((document as PostModel).category as any).slug}/${
            (document as PostModel).slug
          }`
        case 'note':
          return `/notes/${(document as NoteModel).nid}`
        case 'page':
          return `/${(document as PageModel).slug}`
      }
    })()

    const url = new URL(relativePath!, webUrl)

    const structure = await this.service.getRenderedMarkdownHtmlStructure(
      markdownMacros,
      document.title,
      theme,
    )

    const html = render(await this.service.getMarkdownEjsRenderTemplate(), {
      ...structure,

      title: document.title,
      footer: `<p>本文渲染于 ${getShortDateTime(
        new Date(),
      )}，由 marked.js 解析生成，用时 ${(performance.now() - now).toFixed(
        2,
      )}ms</p>
      <p>作者：${username}，撰写于${dayjs(document.created).format('llll')}</p>
        <p>原文地址：<a href="${url}">${decodeURIComponent(
        url.toString(),
      )}</a></p>
        `,
    })

    return html.trim()
  }

  /**
   * 后台预览 Markdown 可用接口, 传入 `title` 和 `md`
   */
  @Post('/markdown')
  @HttpCache.disable
  @Auth()
  @Header('content-type', 'text/html')
  async markdownPreview(
    @Body() body: MarkdownPreviewDto,
    @Query('theme') theme: string,
  ) {
    const { md, title } = body
    const html = this.service.renderMarkdownContent(md)
    const structure = await this.service.getRenderedMarkdownHtmlStructure(
      html,
      title,
      theme,
    )
    return render(await this.service.getMarkdownEjsRenderTemplate(), {
      ...structure,

      title: xss(title),
    }).trim()
  }
}
