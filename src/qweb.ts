import h from "../libs/snabbdom/src/h";
import { VNode } from "../libs/snabbdom/src/vnode";

//------------------------------------------------------------------------------
// Types
//------------------------------------------------------------------------------

export type EvalContext = { [key: string]: any };
export type RawTemplate = string;
export type CompiledTemplate<T> = (context: EvalContext, extra: any) => T;
type ProcessedTemplate = Element;

const RESERVED_WORDS = "true,false,NaN,null,undefined,debugger,console,window,in,instanceof,new,function,return,this,typeof,eval,void,Math,RegExp,Array,Object,Date".split(
  ","
);

const WORD_REPLACEMENT = {
  and: "&&",
  or: "||",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<="
};

const DISABLED_TAGS = [
  "input",
  "textarea",
  "button",
  "select",
  "option",
  "optgroup"
];

const lineBreakRE = /[\r\n]/;
const whitespaceRE = /\s+/g;

//------------------------------------------------------------------------------
// Compilation Context
//------------------------------------------------------------------------------

export class Context {
  nextID: number = 1;
  code: string[] = [];
  variables: { [key: string]: any } = {};
  definedVariables: { [key: string]: string } = {};
  escaping: boolean = false;
  parentNode: number | null = null;
  rootNode: number | null = null;
  indentLevel: number = 0;
  rootContext: Context;
  caller: Element | undefined;
  shouldDefineOwner: boolean = false;
  shouldProtectContext: boolean = false;
  inLoop: boolean = false;
  inPreTag: boolean = false;
  templateName: string;

  constructor(name?: string) {
    this.rootContext = this;
    this.templateName = name || "noname";
    this.addLine("var h = this.utils.h;");
  }

  generateID(): number {
    const id = this.rootContext.nextID++;
    return id;
  }

  withParent(node: number): Context {
    if (this === this.rootContext && this.parentNode) {
      throw new Error("A template should not have more than one root node");
    }
    if (!this.rootContext.rootNode) {
      this.rootContext.rootNode = node;
    }
    return this.subContext("parentNode", node);
  }

  subContext(key: keyof Context, value: any): Context {
    const newContext = Object.create(this);
    newContext[key] = value;
    return newContext;
  }

  indent() {
    this.indentLevel++;
  }

  dedent() {
    this.indentLevel--;
  }

  addLine(line: string) {
    const prefix = new Array(this.indentLevel + 2).join("    ");
    this.code.push(prefix + line);
  }

  addIf(condition: string) {
    this.addLine(`if (${condition}) {`);
    this.indent();
  }

  addElse() {
    this.dedent();
    this.addLine("} else {");
    this.indent();
  }

  closeIf() {
    this.dedent();
    this.addLine("}");
  }

  getValue(val: any): any {
    return val in this.variables ? this.getValue(this.variables[val]) : val;
  }

  formatExpression(e: string): string {
    e = e.trim();
    if (e[0] === "{" && e[e.length - 1] === "}") {
      const innerExpr = e
        .slice(1, -1)
        .split(",")
        .map(p => {
          let [key, val] = p.trim().split(":");
          if (key === "") {
            return "";
          }
          if (!val) {
            val = key;
          }
          return `${key}: ${this.formatExpression(val)}`;
        })
        .join(",");
      return "{" + innerExpr + "}";
    }

    // Thanks CHM for this code...
    const chars = e.split("");
    let instring = "";
    let invar = "";
    let invarPos = 0;
    let r = "";
    chars.push(" ");
    for (var i = 0, ilen = chars.length; i < ilen; i++) {
      var c = chars[i];
      if (instring.length) {
        if (c === instring && chars[i - 1] !== "\\") {
          instring = "";
        }
      } else if (c === '"' || c === "'") {
        instring = c;
      } else if (c.match(/[a-zA-Z_\$]/) && !invar.length) {
        invar = c;
        invarPos = i;
        continue;
      } else if (c.match(/\W/) && invar.length) {
        // TODO: Should check for possible spaces before dot
        if (chars[invarPos - 1] !== "." && RESERVED_WORDS.indexOf(invar) < 0) {
          if (!(invar in this.definedVariables)) {
            invar =
              WORD_REPLACEMENT[invar] ||
              (invar in this.variables &&
                this.formatExpression(this.variables[invar])) ||
              "context['" + invar + "']";
          }
        }
        r += invar;
        invar = "";
      } else if (invar.length) {
        invar += c;
        continue;
      }
      r += c;
    }
    const result = r.slice(0, -1);
    return result;
  }
}

//------------------------------------------------------------------------------
// QWeb rendering engine
//------------------------------------------------------------------------------

export class QWeb {
  processedTemplates: { [name: string]: ProcessedTemplate } = {};
  templates: { [name: string]: CompiledTemplate<VNode> } = {};
  directives: Directive[] = [];
  directiveNames: { [key: string]: 1 };

  constructor(data?: string) {
    this.directiveNames = {
      as: 1,
      name: 1,
      value: 1,
      att: 1,
      attf: 1,
      props: 1,
      key: 1,
      keepalive: 1,
      debug: 1
    };
    [
      forEachDirective,
      escDirective,
      rawDirective,
      setDirective,
      elseDirective,
      elifDirective,
      ifDirective,
      callDirective,
      onDirective,
      refDirective,
      widgetDirective
    ].forEach(d => this.addDirective(d));
    if (data) {
      this.loadTemplates(data);
    }
  }

  utils = {
    h: h,
    getFragment(str: string): DocumentFragment {
      const temp = document.createElement("template");
      temp.innerHTML = str;
      return temp.content;
    },
    objectToAttrString(obj: Object): string {
      let classes: string[] = [];
      for (let k in obj) {
        if (obj[k]) {
          classes.push(k);
        }
      }
      return classes.join(" ");
    }
  };

  addDirective(dir: Directive) {
    this.directives.push(dir);
    this.directiveNames[dir.name] = 1;
    this.directives.sort((d1, d2) => d1.priority - d2.priority);
  }

  /**
   * Add a template to the internal template map.  Note that it is not
   * immediately compiled.
   */
  addTemplate(
    name: string,
    template: RawTemplate,
    allowDuplicates: boolean = false
  ) {
    if (name in this.processedTemplates) {
      if (allowDuplicates) {
        return;
      } else {
        throw new Error(`Template ${name} already defined`);
      }
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(template, "text/xml");
    if (!doc.firstChild) {
      throw new Error("Invalid template (should not be empty)");
    }
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("Invalid XML in template");
    }
    let elem = doc.firstChild as Element;
    this._processTemplate(elem);

    this.processedTemplates[name] = elem;
  }

  _processTemplate(elem: Element) {
    let tbranch = elem.querySelectorAll("[t-elif], [t-else]");
    for (let i = 0, ilen = tbranch.length; i < ilen; i++) {
      let node = tbranch[i];
      let prevElem = node.previousElementSibling!;
      let pattr = function(name) {
        return prevElem.getAttribute(name);
      };
      let nattr = function(name) {
        return +!!node.getAttribute(name);
      };
      if (prevElem && (pattr("t-if") || pattr("t-elif"))) {
        if (pattr("t-foreach")) {
          throw new Error(
            "t-if cannot stay at the same level as t-foreach when using t-elif or t-else"
          );
        }
        if (
          ["t-if", "t-elif", "t-else"].map(nattr).reduce(function(a, b) {
            return a + b;
          }) > 1
        ) {
          throw new Error(
            "Only one conditional branching directive is allowed per node"
          );
        }
        // All text nodes between branch nodes are removed
        let textNode;
        while ((textNode = node.previousSibling) !== prevElem) {
          if (textNode.nodeValue.trim().length) {
            throw new Error("text is not allowed between branching directives");
          }
          textNode.remove();
        }
      } else {
        throw new Error(
          "t-elif and t-else directives must be preceded by a t-if or t-elif directive"
        );
      }
    }
  }
  /**
   * Load templates from a xml (as a string).  This will look up for the first
   * <templates> tag, and will consider each child of this as a template, with
   * the name given by the t-name attribute.
   */
  loadTemplates(xmlstr: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlstr, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("Invalid XML in template");
    }
    const templates = doc.getElementsByTagName("templates")[0];
    if (!templates) {
      return;
    }
    for (let elem of <any>templates.children) {
      const name = elem.getAttribute("t-name");
      this._processTemplate(elem);
      this.processedTemplates[name] = elem;
    }
  }
  /**
   * Render a template
   *
   * @param {string} name the template should already have been added
   */
  render(name: string, context: EvalContext = {}, extra: any = null): VNode {
    if (!(name in this.processedTemplates)) {
      throw new Error(`Template ${name} does not exist`);
    }
    const template = this.templates[name] || this._compile(name);
    return template.call(this, context, extra);
  }

  _compile(name: string): CompiledTemplate<VNode> {
    if (name in this.templates) {
      return this.templates[name];
    }

    const mainNode = this.processedTemplates[name];
    const isDebug = (<Element>mainNode).attributes.hasOwnProperty("t-debug");
    const ctx = new Context(name);
    this._compileNode(mainNode, ctx);

    if (ctx.shouldProtectContext) {
      ctx.code.unshift("    context = Object.create(context);");
    }
    if (ctx.shouldDefineOwner) {
      // this is necessary to prevent some directives (t-forach for ex) to
      // pollute the rendering context by adding some keys in it.
      ctx.code.unshift("    let owner = context;");
    }

    if (!ctx.rootNode) {
      throw new Error("A template should have one root node");
    }
    ctx.addLine(`return vn${ctx.rootNode};`);
    if (isDebug) {
      ctx.code.unshift("    debugger");
    }
    let template;
    try {
      template = new Function(
        "context",
        "extra",
        ctx.code.join("\n")
      ) as CompiledTemplate<VNode>;
    } catch (e) {
      throw new Error(
        `Invalid generated code while compiling template '${ctx.templateName.replace(
          /`/g,
          "'"
        )}': ${e.message}`
      );
    }
    if (isDebug) {
      console.log(
        `Template: ${
          this.processedTemplates[name].outerHTML
        }\nCompiled code:\n` + template.toString()
      );
    }
    this.templates[name] = template;
    return template;
  }

  /**
   * Generate code from an xml node
   *
   */
  _compileNode(node: ChildNode, ctx: Context) {
    if (!(node instanceof Element)) {
      // this is a text node, there are no directive to apply
      let text = node.textContent!;
      if (!ctx.inPreTag) {
        if (lineBreakRE.test(text) && !text.trim()) {
          return;
        }
        text = text.replace(whitespaceRE, " ");
      }
      if (ctx.parentNode) {
        ctx.addLine(`c${ctx.parentNode}.push({text: \`${text}\`});`);
      } else {
        // this is an unusual situation: this text node is the result of the
        // template rendering.
        let nodeID = ctx.generateID();
        ctx.addLine(`var vn${nodeID} = {text: \`${text}\`};`);
        ctx.rootContext.rootNode = nodeID;
        ctx.rootContext.parentNode = nodeID;
      }
      return;
    }

    const attributes = (<Element>node).attributes;

    const validDirectives: {
      directive: Directive;
      value: string;
      fullName: string;
    }[] = [];

    let withHandlers = false;

    // maybe this is not optimal: we iterate on all attributes here, and again
    // just after for each directive.
    for (let i = 0; i < attributes.length; i++) {
      let attrName = attributes[i].name;
      if (attrName.startsWith("t-")) {
        let dName = attrName.slice(2).split("-")[0];
        if (!(dName in this.directiveNames)) {
          throw new Error(`Unknown QWeb directive: '${attrName}'`);
        }
      }
    }

    for (let directive of this.directives) {
      let fullName;
      let value;
      for (let i = 0; i < attributes.length; i++) {
        const name = attributes[i].name;
        if (
          name === "t-" + directive.name ||
          name.startsWith("t-" + directive.name + "-")
        ) {
          fullName = name;
          value = attributes[i].textContent;
          validDirectives.push({ directive, value, fullName });
          if (directive.name === "on") {
            withHandlers = true;
          }
        }
      }
    }
    for (let { directive, value, fullName } of validDirectives) {
      if (directive.atNodeEncounter) {
        const isDone = directive.atNodeEncounter({
          node,
          qweb: this,
          ctx,
          fullName,
          value
        });
        if (isDone) {
          return;
        }
      }
    }

    if (node.nodeName !== "t") {
      let nodeID = this._compileGenericNode(node, ctx, withHandlers);
      ctx = ctx.withParent(nodeID);

      for (let { directive, value, fullName } of validDirectives) {
        if (directive.atNodeCreation) {
          directive.atNodeCreation({
            node,
            qweb: this,
            ctx,
            fullName,
            value,
            nodeID
          });
        }
      }
    }
    if (node.nodeName === "pre") {
      ctx = ctx.subContext("inPreTag", true);
    }

    this._compileChildren(node, ctx);

    for (let { directive, value, fullName } of validDirectives) {
      if (directive.finalize) {
        directive.finalize({ node, qweb: this, ctx, fullName, value });
      }
    }
  }

  _compileGenericNode(
    node: ChildNode,
    ctx: Context,
    withHandlers: boolean = true
  ): number {
    // nodeType 1 is generic tag
    if (node.nodeType !== 1) {
      throw new Error("unsupported node type");
    }
    const attributes = (<Element>node).attributes;
    const attrs: string[] = [];
    const props: string[] = [];
    const tattrs: number[] = [];

    function handleBooleanProps(key, val) {
      let isProp = false;
      if (node.nodeName === "input" && key === "checked") {
        let type = (<Element>node).getAttribute("type");
        if (type === "checkbox" || type === "radio") {
          isProp = true;
        }
      }
      if (node.nodeName === "option" && key === "selected") {
        isProp = true;
      }
      if (key === "disabled" && DISABLED_TAGS.indexOf(node.nodeName) > -1) {
        isProp = true;
      }
      if (
        (key === "readonly" && node.nodeName === "input") ||
        node.nodeName === "textarea"
      ) {
        isProp = true;
      }
      if (isProp) {
        props.push(`${key}: _${val}`);
      }
    }

    for (let i = 0; i < attributes.length; i++) {
      let name = attributes[i].name;
      const value = attributes[i].textContent!;

      // regular attributes
      if (
        !name.startsWith("t-") &&
        !(<Element>node).getAttribute("t-attf-" + name)
      ) {
        const attID = ctx.generateID();
        ctx.addLine(`var _${attID} = '${value}';`);
        if (!name.match(/^[a-zA-Z]+$/)) {
          // attribute contains 'non letters' => we want to quote it
          name = '"' + name + '"';
        }
        attrs.push(`${name}: _${attID}`);
        handleBooleanProps(name, attID);
      }

      // dynamic attributes
      if (name.startsWith("t-att-")) {
        let attName = name.slice(6);
        let formattedValue = ctx.formatExpression(ctx.getValue(value!));
        if (
          formattedValue[0] === "{" &&
          formattedValue[formattedValue.length - 1] === "}"
        ) {
          formattedValue = `this.utils.objectToAttrString(${formattedValue})`;
        }
        const attID = ctx.generateID();
        if (!attName.match(/^[a-zA-Z]+$/)) {
          // attribute contains 'non letters' => we want to quote it
          attName = '"' + attName + '"';
        }
        // we need to combine dynamic with non dynamic attributes:
        // class="a" t-att-class="'yop'" should be rendered as class="a yop"
        const attValue = (<Element>node).getAttribute(attName);
        if (attValue) {
          const attValueID = ctx.generateID();
          ctx.addLine(`var _${attValueID} = ${formattedValue};`);
          formattedValue = `'${attValue}' + (_${attValueID} ? ' ' + _${attValueID} : '')`;
          const attrIndex = attrs.findIndex(att =>
            att.startsWith(attName + ":")
          );
          attrs.splice(attrIndex, 1);
        }
        ctx.addLine(`var _${attID} = ${formattedValue};`);
        attrs.push(`${attName}: _${attID}`);
        handleBooleanProps(attName, attID);
      }

      if (name.startsWith("t-attf-")) {
        let attName = name.slice(7);
        if (!attName.match(/^[a-zA-Z]+$/)) {
          // attribute contains 'non letters' => we want to quote it
          attName = '"' + attName + '"';
        }
        const formattedExpr = value!.replace(
          /\{\{.*?\}\}/g,
          s => "${" + ctx.formatExpression(s.slice(2, -2)) + "}"
        );
        const attID = ctx.generateID();
        let staticVal = (<Element>node).getAttribute(attName);
        if (staticVal) {
          ctx.addLine(
            `var _${attID} = '${staticVal} ' + \`${formattedExpr}\`;`
          );
        } else {
          ctx.addLine(`var _${attID} = \`${formattedExpr}\`;`);
        }
        attrs.push(`${attName}: _${attID}`);
      }

      // t-att= attributes
      if (name === "t-att") {
        let id = ctx.generateID();
        ctx.addLine(`var _${id} = ${ctx.formatExpression(value!)};`);
        tattrs.push(id);
      }
    }
    let nodeID = ctx.generateID();
    const parts = [`key:${nodeID}`];
    if (attrs.length + tattrs.length > 0) {
      parts.push(`attrs:{${attrs.join(",")}}`);
    }
    if (props.length > 0) {
      parts.push(`props:{${props.join(",")}}`);
    }
    if (withHandlers) {
      parts.push(`on:{}`);
    }

    ctx.addLine(`var c${nodeID} = [], p${nodeID} = {${parts.join(",")}};`);
    for (let id of tattrs) {
      ctx.addIf(`_${id} instanceof Array`);
      ctx.addLine(`p${nodeID}.attrs[_${id}[0]] = _${id}[1];`);
      ctx.addElse();
      ctx.addLine(`for (let key in _${id}) {`);
      ctx.indent();
      ctx.addLine(`p${nodeID}.attrs[key] = _${id}[key];`);
      ctx.dedent();
      ctx.addLine(`}`);
      ctx.closeIf();
    }
    ctx.addLine(
      `var vn${nodeID} = h('${node.nodeName}', p${nodeID}, c${nodeID});`
    );
    if (ctx.parentNode) {
      ctx.addLine(`c${ctx.parentNode}.push(vn${nodeID});`);
    }

    return nodeID;
  }

  _compileChildren(node: ChildNode, ctx: Context) {
    if (node.childNodes.length > 0) {
      for (let child of Array.from(node.childNodes)) {
        this._compileNode(child, ctx);
      }
    }
  }
}

//------------------------------------------------------------------------------
// QWeb Directives
//------------------------------------------------------------------------------

interface CompilationInfo {
  nodeID?: number;
  node: Element;
  qweb: QWeb;
  ctx: Context;
  fullName: string;
  value: string;
}

export interface Directive {
  name: string;
  priority: number;
  // if return true, then directive is fully applied and there is no need to
  // keep processing node. Otherwise, we keep going.
  atNodeEncounter?(info: CompilationInfo): boolean;
  atNodeCreation?(info: CompilationInfo): void;
  finalize?(info: CompilationInfo): void;
}

function compileValueNode(value: any, node: Element, qweb: QWeb, ctx: Context) {
  if (value === "0" && ctx.caller) {
    qweb._compileNode(ctx.caller, ctx);
    return;
  }

  if (typeof value === "string") {
    let exprID = value;
    if (!(value in ctx.definedVariables)) {
      exprID = `_${ctx.generateID()}`;
      ctx.addLine(`var ${exprID} = ${ctx.formatExpression(value)};`);
    }
    ctx.addIf(`${exprID} || ${exprID} === 0`);
    if (!ctx.parentNode) {
      throw new Error("Should not have a text node without a parent");
    }
    if (ctx.escaping) {
      ctx.addLine(`c${ctx.parentNode}.push({text: ${exprID}});`);
    } else {
      let fragID = ctx.generateID();
      ctx.addLine(`var frag${fragID} = this.utils.getFragment(${exprID})`);
      let tempNodeID = ctx.generateID();
      ctx.addLine(`var p${tempNodeID} = {hook: {`);
      ctx.addLine(
        `  insert: n => n.elm.parentNode.replaceChild(frag${fragID}, n.elm),`
      );
      ctx.addLine(`}};`);
      ctx.addLine(`var vn${tempNodeID} = h('div', p${tempNodeID})`);
      ctx.addLine(`c${ctx.parentNode}.push(vn${tempNodeID});`);
    }
    if (node.childNodes.length) {
      ctx.addElse();
      qweb._compileChildren(node, ctx);
    }
    ctx.closeIf();
    return;
  }
  if (value instanceof NodeList) {
    for (let node of Array.from(value)) {
      qweb._compileNode(<ChildNode>node, ctx);
    }
  }
}

const escDirective: Directive = {
  name: "esc",
  priority: 70,
  atNodeEncounter({ node, qweb, ctx }): boolean {
    if (node.nodeName !== "t") {
      let nodeID = qweb._compileGenericNode(node, ctx);
      ctx = ctx.withParent(nodeID);
    }
    let value = ctx.getValue(node.getAttribute("t-esc")!);
    compileValueNode(value, node, qweb, ctx.subContext("escaping", true));
    return true;
  }
};

const rawDirective: Directive = {
  name: "raw",
  priority: 80,
  atNodeEncounter({ node, qweb, ctx }): boolean {
    if (node.nodeName !== "t") {
      let nodeID = qweb._compileGenericNode(node, ctx);
      ctx = ctx.withParent(nodeID);
    }
    let value = ctx.getValue(node.getAttribute("t-raw")!);
    compileValueNode(value, node, qweb, ctx);
    return true;
  }
};

const setDirective: Directive = {
  name: "set",
  priority: 60,
  atNodeEncounter({ node, ctx }): boolean {
    const variable = node.getAttribute("t-set")!;
    let value = node.getAttribute("t-value")!;
    if (value) {
      const varName = `_${ctx.generateID()}`;
      const formattedValue = ctx.formatExpression(value);
      ctx.addLine(`var ${varName} = ${formattedValue}`);
      ctx.definedVariables[varName] = formattedValue;
      ctx.variables[variable] = varName;
    } else {
      ctx.variables[variable] = node.childNodes;
    }
    return true;
  }
};

const ifDirective: Directive = {
  name: "if",
  priority: 20,
  atNodeEncounter({ node, ctx }): boolean {
    let cond = ctx.getValue(node.getAttribute("t-if")!);
    ctx.addIf(`${ctx.formatExpression(cond)}`);
    return false;
  },
  finalize({ ctx }) {
    ctx.closeIf();
  }
};

const elifDirective: Directive = {
  name: "elif",
  priority: 30,
  atNodeEncounter({ node, ctx }): boolean {
    let cond = ctx.getValue(node.getAttribute("t-elif")!);
    ctx.addLine(`else if (${ctx.formatExpression(cond)}) {`);
    ctx.indent();
    return false;
  },
  finalize({ ctx }) {
    ctx.closeIf();
  }
};

const elseDirective: Directive = {
  name: "else",
  priority: 40,
  atNodeEncounter({ ctx }): boolean {
    ctx.addLine(`else {`);
    ctx.indent();
    return false;
  },
  finalize({ ctx }) {
    ctx.closeIf();
  }
};

const callDirective: Directive = {
  name: "call",
  priority: 50,
  atNodeEncounter({ node, qweb, ctx }): boolean {
    if (node.nodeName !== "t") {
      throw new Error("Invalid tag for t-call directive (should be 't')");
    }
    const subTemplate = node.getAttribute("t-call")!;
    const nodeTemplate = qweb.processedTemplates[subTemplate];
    if (!nodeTemplate) {
      throw new Error(`Cannot find template "${subTemplate}" (t-call)`);
    }
    const nodeCopy = node.cloneNode(true) as Element;
    nodeCopy.removeAttribute("t-call");

    // extract variables from nodecopy
    const tempCtx = new Context();
    tempCtx.nextID = ctx.rootContext.nextID;
    qweb._compileNode(nodeCopy, tempCtx);
    const vars = Object.assign({}, ctx.variables, tempCtx.variables);
    var definedVariables = Object.assign(
      {},
      ctx.definedVariables,
      tempCtx.definedVariables
    );
    ctx.rootContext.nextID = tempCtx.nextID;

    // open new scope, if necessary
    const hasNewVariables = Object.keys(definedVariables).length > 0;
    if (hasNewVariables) {
      ctx.addLine("{");
      ctx.indent();
    }

    // add new variables, if any
    for (let key in definedVariables) {
      ctx.addLine(`let ${key} = ${definedVariables[key]}`);
    }

    // compile sub template
    const subCtx = ctx
      .subContext("caller", nodeCopy)
      .subContext("variables", Object.create(vars))
      .subContext("definedVariables", Object.create(definedVariables));

    qweb._compileNode(nodeTemplate, subCtx);

    // close new scope
    if (hasNewVariables) {
      ctx.dedent();
      ctx.addLine("}");
    }

    return true;
  }
};

const forEachDirective: Directive = {
  name: "foreach",
  priority: 10,
  atNodeEncounter({ node, qweb, ctx }): boolean {
    ctx.rootContext.shouldProtectContext = true;
    ctx = ctx.subContext("inLoop", true);
    const elems = node.getAttribute("t-foreach")!;
    const name = node.getAttribute("t-as")!;
    let arrayID = ctx.generateID();
    ctx.addLine(`var _${arrayID} = ${ctx.formatExpression(elems)};`);
    ctx.addLine(
      `if (!_${arrayID}) { throw new Error('QWeb error: Invalid loop expression')}`
    );
    ctx.addLine(
      `if (typeof _${arrayID} === 'number') { _${arrayID} = Array.from(Array(_${arrayID}).keys())}`
    );
    let keysID = ctx.generateID();
    ctx.addLine(
      `var _${keysID} = _${arrayID} instanceof Array ? _${arrayID} : Object.keys(_${arrayID});`
    );
    let valuesID = ctx.generateID();
    ctx.addLine(
      `var _${valuesID} = _${arrayID} instanceof Array ? _${arrayID} : Object.values(_${arrayID});`
    );
    ctx.addLine(`for (let i = 0; i < _${keysID}.length; i++) {`);
    ctx.indent();
    ctx.addLine(`context.${name}_first = i === 0;`);
    ctx.addLine(`context.${name}_last = i === _${keysID}.length - 1;`);
    ctx.addLine(`context.${name}_parity = i % 2 === 0 ? 'even' : 'odd';`);
    ctx.addLine(`context.${name}_index = i;`);
    ctx.addLine(`context.${name} = _${keysID}[i];`);
    ctx.addLine(`context.${name}_value = _${valuesID}[i];`);
    const nodeCopy = <Element>node.cloneNode(true);
    nodeCopy.removeAttribute("t-foreach");
    qweb._compileNode(nodeCopy, ctx);
    ctx.dedent();
    ctx.addLine("}");
    return true;
  }
};

const onDirective: Directive = {
  name: "on",
  priority: 90,
  atNodeCreation({ ctx, fullName, value, nodeID }) {
    ctx.rootContext.shouldDefineOwner = true;
    const eventName = fullName.slice(5);
    if (!eventName) {
      throw new Error("Missing event name with t-on directive");
    }
    let extraArgs;
    let handler = value.replace(/\(.*\)/, function(args) {
      extraArgs = args.slice(1, -1);
      return "";
    });
    let error = `(function () {throw new Error('Missing handler \\'' + '${handler}' + \`\\' when evaluating template '${ctx.templateName.replace(
      /`/g,
      "'"
    )}'\`)})()`;
    if (extraArgs) {
      ctx.addLine(
        `p${nodeID}.on['${eventName}'] = (context['${handler}'] || ${error}).bind(owner, ${ctx.formatExpression(
          extraArgs
        )});`
      );
    } else {
      ctx.addLine(
        `extra.handlers['${eventName}' + ${nodeID}] = extra.handlers['${eventName}' + ${nodeID}] || (context['${handler}'] || ${error}).bind(owner);`
      );
      ctx.addLine(
        `p${nodeID}.on['${eventName}'] = extra.handlers['${eventName}' + ${nodeID}];`
      );
    }
  }
};

const refDirective: Directive = {
  name: "ref",
  priority: 95,
  atNodeCreation({ ctx, node }) {
    let ref = node.getAttribute("t-ref")!;
    ctx.addLine(`p${ctx.parentNode}.hook = {
            create: (_, n) => context.refs[${ctx.formatExpression(
              ref
            )}] = n.elm,
        };`);
  }
};

const widgetDirective: Directive = {
  name: "widget",
  priority: 100,
  atNodeEncounter({ ctx, value, node }): boolean {
    ctx.addLine("//WIDGET");
    ctx.rootContext.shouldDefineOwner = true;
    let props = node.getAttribute("t-props");
    let keepAlive = node.getAttribute("t-keepalive") ? true : false;

    // t-on- events...
    const events: [string, string][] = [];
    const attributes = (<Element>node).attributes;
    for (let i = 0; i < attributes.length; i++) {
      const name = attributes[i].name;
      if (name.startsWith("t-on-")) {
        events.push([name.slice(5), attributes[i].textContent!]);
      }
    }

    let key = node.getAttribute("t-key");
    if (key) {
      key = `"${key}"`;
    } else {
      key = node.getAttribute("t-att-key");
      if (key) {
        key = ctx.formatExpression(key);
      }
    }
    if (props) {
      props = ctx.formatExpression(props);
    }
    let dummyID = ctx.generateID();
    let defID = ctx.generateID();
    let widgetID = ctx.generateID();
    let keyID = key && ctx.generateID();
    if (key) {
      // we bind a variable to the key (could be a complex expression, so we
      // want to evaluate it only once)
      ctx.addLine(`let key${keyID} = ${key};`);
    }
    ctx.addLine(`let _${dummyID}_index = c${ctx.parentNode}.length;`);
    ctx.addLine(`c${ctx.parentNode}.push(null);`);
    ctx.addLine(`let def${defID};`);
    let templateID = key
      ? `key${keyID}`
      : ctx.inLoop
      ? `String(-${widgetID} - i)`
      : String(widgetID);
    ctx.addLine(
      `let w${widgetID} = ${templateID} in context.__owl__.cmap ? context.__owl__.children[context.__owl__.cmap[${templateID}]] : false;`
    );
    ctx.addLine(`let props${widgetID} = ${props || "{}"};`);
    ctx.addLine(`let isNew${widgetID} = !w${widgetID};`);

    // check if we can reuse current rendering promise
    ctx.addIf(`w${widgetID} && w${widgetID}.__owl__.renderPromise`);
    ctx.addIf(`w${widgetID}.__owl__.isStarted`);
    ctx.addLine(
      `def${defID} = w${widgetID}.updateProps(props${widgetID}, extra.forceUpdate);`
    );
    ctx.addElse();
    ctx.addLine(`isNew${widgetID} = true`);
    ctx.addIf(`props${widgetID} === w${widgetID}.__owl__.renderProps`);
    ctx.addLine(`def${defID} = w${widgetID}.__owl__.renderPromise;`);
    ctx.addElse();
    ctx.addLine(`w${widgetID}.destroy();`);
    ctx.addLine(`w${widgetID} = false`);
    ctx.closeIf();
    ctx.closeIf();
    ctx.closeIf();

    ctx.addIf(`!def${defID}`);
    ctx.addIf(`w${widgetID}`);
    ctx.addLine(
      `def${defID} = w${widgetID}.updateProps(props${widgetID}, extra.forceUpdate);`
    );
    ctx.addElse();
    ctx.addLine(
      `w${widgetID} = new context.widgets['${value}'](owner, props${widgetID});`
    );
    ctx.addLine(
      `context.__owl__.cmap[${templateID}] = w${widgetID}.__owl__.id;`
    );
    for (let [event, method] of events) {
      ctx.addLine(`w${widgetID}.on('${event}', owner, owner['${method}'])`);
    }
    let ref = node.getAttribute("t-ref");
    if (ref) {
      ctx.addLine(`context.refs[${ctx.formatExpression(ref)}] = w${widgetID};`);
    }

    ctx.addLine(`def${defID} = w${widgetID}._prepare();`);
    ctx.closeIf();
    ctx.closeIf();

    ctx.addIf(`isNew${widgetID}`);
    ctx.addLine(
      `def${defID} = def${defID}.then(vnode=>{let pvnode=h(vnode.sel, {key: ${templateID}});c${
        ctx.parentNode
      }[_${dummyID}_index]=pvnode;pvnode.data.hook = {insert(vn){let nvn=w${widgetID}._mount(vnode, vn.elm);pvnode.elm=nvn.elm},remove(){w${widgetID}.${
        keepAlive ? "unmount" : "destroy"
      }()},destroy(){w${widgetID}.${
        keepAlive ? "unmount" : "destroy"
      }()}}; w${widgetID}.__owl__.pvnode = pvnode;});`
    );
    ctx.addElse();
    ctx.addLine(
      `def${defID} = def${defID}.then(()=>{if (w${widgetID}.__owl__.isDestroyed) {return};let vnode;if (!w${widgetID}.__owl__.vnode){vnode=w${widgetID}.__owl__.pvnode} else { vnode=h(w${widgetID}.__owl__.vnode.sel, {key: ${templateID}});vnode.elm=w${widgetID}.el;vnode.data.hook = {insert(a){a.elm.parentNode.replaceChild(w${widgetID}.el,a.elm);a.elm=w${widgetID}.el;w${widgetID}.__mount();},remove(){w${widgetID}.${
        keepAlive ? "unmount" : "destroy"
      }()}, destroy() {w${widgetID}.${keepAlive ? "unmount" : "destroy"}()}}}c${
        ctx.parentNode
      }[_${dummyID}_index]=vnode;});`
    );
    ctx.closeIf();

    ctx.addLine(`extra.promises.push(def${defID});`);

    if (node.hasAttribute("t-if") || node.hasAttribute("t-else")) {
      ctx.closeIf();
    }

    return true;
  }
};
