// Bun's bundler turns image imports into URLs.
declare module "*.webp" {
  const url: string;
  export default url;
}
