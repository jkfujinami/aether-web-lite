export abstract class Component {
  protected element: HTMLElement;

  constructor(tagName: string = 'div', className: string = '') {
    this.element = document.createElement(tagName);
    if (className) {
      this.element.className = className;
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * コンポーネントを親要素にマウントする
   */
  public mount(parent: HTMLElement) {
    parent.appendChild(this.element);
    this.onMounted();
  }

  /**
   * コンポーネントを破棄する
   */
  public unmount() {
    this.element.remove();
    this.onUnmounted();
  }

  protected onMounted(): void {}
  protected onUnmounted(): void {}

  /**
   * テンプレートからHTMLを流し込む
   */
  protected render(html: string) {
    this.element.innerHTML = html;
  }
}
