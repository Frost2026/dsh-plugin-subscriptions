/**
 * Ambient declarations for shell platform modules this package imports at
 * VALUE level but cannot resolve at typecheck time: both are entries of the
 * shell's loader module table (tsdown externals), answered at runtime, yet
 * neither is a declared devDependency, so pnpm's isolated layout hides them
 * from tsc. Each declaration mirrors the verified source contract cited in
 * its comment; adding the real link: devDependencies later makes these
 * redundant (delete this file then — the real types win).
 */

declare module '@deepseek-ai/dsh-client-ui-attachment' {
  /**
   * Mirror of ImageAttachmentRef (packages/attachment/attachment/src/types.ts);
   * the brand on attachmentId is compile-time only, so string suffices here.
   */
  export interface ImageAttachmentRef {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }

  /** Mirror of ImageLoader (packages/client/ui-attachment/src/MessageImage.tsx). */
  export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

  /** Mirror of ImageLightboxLabels (packages/client/ui-attachment/src/ImageLightbox.tsx). */
  export interface ImageLightboxLabels {
    dialog: string
    close: string
  }

  /** Mirror of MessageImageLabels (packages/client/ui-attachment/src/MessageImage.tsx). */
  export interface MessageImageLabels {
    image: string
    open: string
    openNamed: (label: string) => string
    loading: string
    loadFailed: string
    lightbox: ImageLightboxLabels
  }

  /** Mirror of ImageGallery (packages/client/ui-attachment/src/MessageImage.tsx). */
  export function ImageGallery(props: {
    images: readonly { attachment: ImageAttachmentRef }[]
    load: ImageLoader
    align: 'start' | 'end'
    labels: MessageImageLabels
  }): import('react').ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Mirror of IconSparkle16 (packages/client/ui-primitives/src/icons/index.tsx). */
  export function IconSparkle16(props: {
    size?: number
    className?: string
  }): import('react').ReactNode
}
