import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import sharp from 'sharp'
import path from 'path'
import { fileURLToPath } from 'url'

// Collections
import { Posts } from './collections/Posts'
import { Categories } from './collections/Categories'
import { Tags } from './collections/Tags'
import { Media } from './collections/Media'
import { Users } from './collections/Users'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    meta: {
      titleSuffix: '- Triply CMS',
    },
  },

  // Custom routes to avoid conflict with existing /admin
  routes: {
    admin: '/cms',
    api: '/api/cms',
  },

  collections: [
    Posts,
    Categories,
    Tags,
    Media,
    Users,
  ],

  editor: lexicalEditor(),

  secret: process.env.PAYLOAD_SECRET || 'CHANGE_ME_IN_PRODUCTION_32_CHARS',

  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },

  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
    schemaName: 'payload', // Use separate schema to avoid conflicts with existing tables
    push: false, // Tables already created manually - don't auto-sync
  }),

  sharp,
})
