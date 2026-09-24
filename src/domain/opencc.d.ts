declare module "opencc-js" {
  export function Converter(o: {
    from: string;
    to: string;
  }): (text: string) => string;
}
