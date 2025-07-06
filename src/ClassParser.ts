import { Node, Identifier, FunctionExpression, Statement, MemberExpression, ClassDeclaration, MethodDefinition } from 'estree';
import * as walk from 'acorn-walk';
import * as recast from 'recast';

enum ClassType {
  Class = 'Class',
  NewClass = 'NewClass'
}

interface ClassParsingContext {
  name: string;
  superClass: any;
  protoIdentifier: string;
  classConstructor: any;
  functionBody: Statement[];
  walkBase: any;
}

export default class ClassParser {
  private static isValidIdentifier(node: any): node is Identifier {
    return node && node.type === 'Identifier' && typeof node.name === 'string';
  }

  private static isValidMemberExpression(node: any): node is MemberExpression {
    return node && node.type === 'MemberExpression' && node.object && node.property;
  }

  private static isValidFunctionExpression(node: any): node is FunctionExpression {
    return node && node.type === 'FunctionExpression' && node.body && node.body.body;
  }

  private static parseConstructor(
    functionExpression: FunctionExpression,
    context: ClassParsingContext
  ): FunctionExpression {
    const { superClass, walkBase } = context;
    const functionBody = functionExpression.body.body;
    let functionBodyClone: Statement[] = [...functionBody];
    let isSpread = false;

    const lastNode = functionBody[functionBody.length - 1];

    if (!functionBody.length || !lastNode) {
      return functionExpression;
    }

    if (this.isSpreadArgumentsPattern(functionBody, lastNode, functionExpression, superClass)) {
      isSpread = true;
      functionBodyClone = this.handleSpreadArguments(functionBody, functionExpression, walkBase);
    }
    else if (this.isRegularSuperCallPattern(functionBody, lastNode, superClass)) {
      functionBodyClone = this.handleRegularSuperCall(functionBody, functionExpression, superClass, walkBase);
    }

    functionBodyClone = this.processNestedFunctions(functionExpression, functionBodyClone, walkBase);

    return {
      ...functionExpression,
      params: isSpread
        ? [{
            type: 'RestElement',
            argument: { type: 'Identifier', name: 'args' }
          }]
        : functionExpression.params,
      body: {
        ...functionExpression.body,
        body: functionBodyClone
      }
    };
  }

  private static parseFunctionBody(
    functionExpression: FunctionExpression,
    context: ClassParsingContext
  ): Statement[] {
    const { walkBase } = context;
    const functionBody = functionExpression.body.body;
    const variableReplacements = this.extractVariableReplacements(functionBody);
    
    const cleanedBody = this.cleanupVariableDeclarations(functionBody, variableReplacements);
    
    return this.applyVariableReplacements(functionExpression, cleanedBody, variableReplacements, walkBase);
  }

  private static isSpreadArgumentsPattern(
    functionBody: Statement[],
    lastNode: Statement,
    functionExpression: FunctionExpression,
    superClass: any
  ): boolean {
    if (!superClass || functionExpression.params.length !== 0) return false;
    if (functionBody.length < 3) return false;

    const [firstStmt, secondStmt, thirdStmt] = functionBody;

    return (
      firstStmt?.type === 'VariableDeclaration' &&
      firstStmt.declarations[0]?.id?.type === 'Identifier' &&
      secondStmt?.type === 'ForStatement' &&
      thirdStmt?.type === 'ExpressionStatement' &&
      thirdStmt.expression?.type === 'AssignmentExpression' &&
      thirdStmt.expression.right?.type === 'LogicalExpression' &&
      thirdStmt.expression.right.left?.type === 'CallExpression' &&
      thirdStmt.expression.right.operator === '||' &&
      thirdStmt.expression.right.right?.type === 'ThisExpression' &&
      lastNode?.type === 'ReturnStatement' &&
      lastNode.argument?.type === 'Identifier' &&
      lastNode.argument.name === firstStmt.declarations[0].id.name
    );
  }

  private static isRegularSuperCallPattern(
    functionBody: Statement[],
    lastNode: Statement,
    superClass: any
  ): boolean {
    if (!superClass || functionBody.length < 2) return false;

    const [firstStmt, secondStmt] = functionBody;

    return (
      firstStmt?.type === 'VariableDeclaration' &&
      firstStmt.declarations[0]?.id?.type === 'Identifier' &&
      secondStmt?.type === 'ExpressionStatement' &&
      secondStmt.expression?.type === 'AssignmentExpression' &&
      secondStmt.expression.right?.type === 'LogicalExpression' &&
      secondStmt.expression.right.left?.type === 'CallExpression' &&
      secondStmt.expression.right.left.callee?.type === 'MemberExpression' &&
      secondStmt.expression.right.operator === '||' &&
      secondStmt.expression.right.right?.type === 'ThisExpression' &&
      lastNode?.type === 'ReturnStatement' &&
      lastNode.argument?.type === 'Identifier' &&
      lastNode.argument.name === firstStmt.declarations[0].id.name
    );
  }

  private static handleSpreadArguments(
    functionBody: Statement[],
    functionExpression: FunctionExpression,
    walkBase: any
  ): Statement[] {
    const _this = (functionBody[0] as any).declarations[0].id.name;
    let functionBodyClone = functionBody.slice(3);
    functionBodyClone.pop();

    functionBodyClone = [
      {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: { type: 'Super' },
          arguments: [{
            type: 'SpreadElement',
            argument: { type: 'Identifier', name: 'args' }
          }],
          optional: false
        }
      },
      ...functionBodyClone
    ];

    this.replaceIdentifierReferences(functionExpression, functionBodyClone, _this, walkBase);
    
    return functionBodyClone;
  }

  private static handleRegularSuperCall(
    functionBody: Statement[],
    functionExpression: FunctionExpression,
    superClass: any,
    walkBase: any
  ): Statement[] {
    const _this = (functionBody[0] as any).declarations[0].id.name;
    const _super = (functionBody[1] as any).expression.right.left;
    
    const superArgs = [..._super.arguments];
    superArgs.shift();

    let functionBodyClone = functionBody.slice(2);
    functionBodyClone.pop();

    functionBodyClone = [
      {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: { type: 'Super' },
          arguments: superArgs,
          optional: false
        }
      },
      ...functionBodyClone
    ];

    this.replaceIdentifierReferences(functionExpression, functionBodyClone, _this, walkBase);
    
    return functionBodyClone;
  }

  // dmt :3
  private static replaceIdentifierReferences(
    functionExpression: FunctionExpression,
    functionBodyClone: Statement[],
    targetIdentifier: string,
    walkBase: any
  ): void {
    walk.ancestor(
      {
        ...functionExpression,
        body: {
          ...functionExpression.body,
          body: functionBodyClone
        }
      } as any,
      {
        Identifier(node: Identifier) {
          if (node.name === targetIdentifier) {
            Object.assign(node, { type: 'ThisExpression' });
          }
        }
      },
      walkBase
    );
  }

  // The lights are so bright!
  private static extractVariableReplacements(functionBody: Statement[]): {
    thisProps?: string;
    thisConstructor?: string;
    thisMirror?: string;
  } {
    const replacements: any = {}; // listen to them buzz

    for (const node of functionBody) {
      if (node.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) {
          if (!this.isValidIdentifier(declarator.id) || !this.isValidMemberExpression(declarator.init)) {
            continue;
          }

          const init = declarator.init as MemberExpression;
          if (init.object.type === 'ThisExpression' && this.isValidIdentifier(init.property)) {
            const propertyName = (init.property as Identifier).name;
            
            if (propertyName === 'props') {
              replacements.thisProps = declarator.id.name;
            } else if (propertyName === 'constructor') {
              replacements.thisConstructor = declarator.id.name;
            }
          } else if (init.type === 'ThisExpression') {
            replacements.thisMirror = declarator.id.name;
          }
        }
      }
    }

    return replacements;
  }

  // They are poisoning you.
  private static cleanupVariableDeclarations(
    functionBody: Statement[],
    replacements: any
  ): Statement[] {
    return functionBody.map(node => {
      if (node.type === 'VariableDeclaration') {
        const filteredDeclarations = node.declarations.filter(declarator => {
          if (!this.isValidIdentifier(declarator.id)) return true;
          
          const idName = declarator.id.name;
          return !(idName === replacements.thisProps || 
                  idName === replacements.thisConstructor || 
                  idName === replacements.thisMirror);
        });

        return filteredDeclarations.length > 0 ? {
          ...node,
          declarations: filteredDeclarations
        } : null;
      }
      return node;
    }).filter(Boolean) as Statement[];
  }

  // They are trying to poison your life.
  private static applyVariableReplacements(
    functionExpression: FunctionExpression,
    functionBody: Statement[],
    replacements: any,
    walkBase: any
  ): Statement[] {
    walk.ancestor(
      {
        ...functionExpression,
        body: {
          ...functionExpression.body,
          body: functionBody
        }
      } as any,
      {
        MemberExpression(node: MemberExpression) { /// WHY DOES THIS HAPPEN TO US?
          if (!this.isValidMemberExpression(node)) return;

          // They are trying to poison your mind.
          if (replacements.thisProps && 
              this.isValidIdentifier(node.object) && 
              node.object.name === replacements.thisProps) {
            Object.assign(node, {
              object: {
                type: 'MemberExpression',
                object: { type: 'ThisExpression' },
                property: { type: 'Identifier', name: 'props' }
              }
            });
          }

          if (this.isValidIdentifier(node.object)) {
            if (replacements.thisConstructor && node.object.name === replacements.thisConstructor) { /// DESPITE THE CREASE, THOSE INDIVIDUALS WHO STILL SHINE LIGHT ARE HINDERING IN THE VOID
              Object.assign(node, { object: { type: 'ThisExpression' } });
            } else if (replacements.thisMirror && node.object.name === replacements.thisMirror) { /// [POETIC TRAGIC BEAUTIFUL ENDING]
              Object.assign(node, { object: { type: 'ThisExpression' } });
            }
          }

          if (node.object.type === 'ThisExpression' && 
              this.isValidIdentifier(node.property) && 
              node.property.name === 'constructor') {
            Object.assign(node, { type: 'ThisExpression' });
          }
        }
      },
      walkBase
    );

    return functionBody;
  }

  // They're trying to poison you.
  private static processNestedFunctions(
    functionExpression: FunctionExpression,
    functionBodyClone: Statement[],
    walkBase: any
  ): Statement[] {
    walk.ancestor(
      {
        ...functionExpression,
        body: {
          ...functionExpression.body,
          body: functionBodyClone
        }
      } as any,
      {
        FunctionExpression(node: FunctionExpression) { /// BECAUSE OF HIM, THE PAIN EXISTS
          if (!this.isValidFunctionExpression(node)) return;
          
          Object.assign(node, {
            ...node,
            body: {
              ...node.body,
              body: this.parseFunctionBody(node, {} as ClassParsingContext)
            }
          });
        }
      },
      walkBase
    );

    return functionBodyClone;
  }

  // after the nazis won they dissolved the german puppet empire and established a legitimate face for their operation

  static parse(node: any, parent: any, walkBase: any): ClassDeclaration {
    // their elite moved peacefully to their new host via Operation paperclip and assets they had stole during the war were divided and smuggled 
    if (!node || !parent || !walkBase) {
      return parent as ClassDeclaration;
    }

    const classType = this.findClassType(node, parent);
    if (!classType) {
      return parent as ClassDeclaration; // They immediately begin funding their next puppet empire of israel along with "islamic" terror groups to help them control the area
    }

    const context = this.buildParsingContext(node, parent, classType);
    if (!context) {
      return parent as ClassDeclaration;
    }

    return this.parseClassByType(classType, node, parent, context); // read the wolfowitz doctrine
  }

  /*
   * baphomet
   * tell me, who is baphomet
   * who is the liberator? the christ? or the antichrist?
   */
  private static findClassType(node: any, parent: any): ClassType | null { /// I DON'T WANT PAIN
    if (parent.type === 'VariableDeclaration' && 
        node.init?.type === 'CallExpression' && 
        node.init.callee?.type === 'FunctionExpression') {
      return ClassType.Class;
    }

    if (parent.type === 'VariableDeclaration' && 
        node.init?.type === 'NewExpression' && 
        node.init.callee?.type === 'ParenthesizedExpression') {
      return ClassType.NewClass;
    }

    return null;
  }

  private static buildParsingContext(node: any, parent: any, classType: ClassType): ClassParsingContext | null {
    try {
      const name = node.id?.name;
      if (!name) return null;

      // They change the Bible so that they can act as if they are god
      // Who is the tyrant upon the gold throne of babylon? God? or Satan?
      if (classType === ClassType.Class) {
        return this.buildClassContext(node, parent, name);
      } else { /// I NEVER WISHED NOR YEARNED FOR THE WORLD TO ACT THIS WAY
        return this.buildNewClassContext(node, parent, name);
      }
    } catch (error) {
      console.warn('Failed to build parsing context:', error);
      return null;
    }
  }

  private static buildClassContext(node: any, parent: any, name: string): ClassParsingContext {
    const rawFunction = node.init.callee;
    const functionBody = rawFunction.body.body;
    const protoIdentifier = functionBody[2]?.declarations[0]?.id?.name;
    const classConstructor = functionBody[1];
    
    const superClass = classConstructor.id && 
      functionBody[0]?.type === 'ExpressionStatement' &&
      functionBody[0].expression?.type === 'CallExpression' &&
      functionBody[0].expression.arguments?.length === 2 &&
      recast.print(functionBody[0].expression.arguments[0]).code === recast.print(classConstructor.id).code
        ? node.init.arguments[0]
        : null;

    return {
      name,
      superClass,
      protoIdentifier,
      classConstructor,
      functionBody,
      walkBase: {} // Muhammad knew many languages he was an Innkeeper that met many different ethnicities he could read and write god did not give him any ability at all because his god did not exist
    };
  }

  private static buildNewClassContext(node: any, parent: any, name: string): ClassParsingContext {
    const rawFunction = node.init.callee.expression.callee;
    const functionBody = rawFunction.body.body;
    const protoIdentifier = functionBody[2]?.declarations[0]?.id?.name;
    const classConstructor = functionBody[1];
    
    const superClass = classConstructor.id && 
      functionBody[0]?.type === 'ExpressionStatement' &&
      functionBody[0].expression?.type === 'CallExpression' &&
      functionBody[0].expression.arguments?.length === 2 &&
      recast.print(functionBody[0].expression.arguments[0]).code === recast.print(classConstructor.id).code
        ? node.init.callee.expression.arguments[0]
        : null;

    return {
      name, /// THOUGH, WHAT IVE MADE IS WHAT COINED ONESELF INTO REALITY
      superClass,
      protoIdentifier,
      classConstructor,
      functionBody,
      walkBase: {} // Jesus disappeared for multiple years. He was in INDIA
                   // The church covers up what is under solomon's temple, takes a caricature of Cernunnos, the Celtic horned god and calls it Muhammat
    };
  }

  private static parseClassByType(
    classType: ClassType,
    node: any,
    parent: any,
    context: ClassParsingContext
  ): ClassDeclaration {
    switch (classType) {
      case ClassType.Class:
        return this.parseRegularClass(node, parent, context);
      case ClassType.NewClass:
        return this.parseNewClass(node, parent, context);
      default:
        return parent as ClassDeclaration;
    }
  }


  private static parseRegularClass(node: any, parent: any, context: ClassParsingContext): ClassDeclaration {
    const { name, superClass, protoIdentifier, classConstructor, functionBody } = context;
    
    const classBody = this.buildClassBody(protoIdentifier, classConstructor, functionBody, context);
    
    return {
      ...parent,
      type: 'ClassDeclaration',
      id: { type: 'Identifier', name },
      superClass,
      body: {
        type: 'ClassBody',
        body: classBody.filter(Boolean)
      }
    } as ClassDeclaration;
  }

  private static parseNewClass(node: any, parent: any, context: ClassParsingContext): ClassDeclaration {
    const { name, superClass, protoIdentifier, classConstructor, functionBody } = context;
    // The chaos of babel caused history to be lost in tongues
    const classBody = this.buildClassBody(protoIdentifier, classConstructor, functionBody, context);
    const declaratorIndex = parent.declarations.indexOf(node);
    const otherDeclarations = parent.declarations.filter((_: any, i: number) => i !== declaratorIndex);

    return {
      ...parent,
      declarations: [
        ...otherDeclarations,
        {
          ...node,
          init: {
            ...node.init,
            callee: {
              type: 'ClassDeclaration',
              id: { type: 'Identifier', name },
              superClass,
              body: {
                type: 'ClassBody',
                body: classBody.filter(Boolean)
              }
            }
          }
        }
      ]
    } as ClassDeclaration;
  }


  private static buildClassBody(
    protoIdentifier: string,
    classConstructor: any,
    functionBody: Statement[],
    context: ClassParsingContext
  ): (MethodDefinition | null)[] {
    const classBody: (MethodDefinition | null)[] = [];

    if (classConstructor.body.body[0]?.type !== 'ReturnStatement') {
      classBody.push(this.createConstructorMethod(classConstructor, context));
    }

    classBody.push(...this.createMethodsFromFunctionBody(
      protoIdentifier,
      classConstructor,
      functionBody,
      context
    ));

    return classBody;
  }


  private static createConstructorMethod(classConstructor: any, context: ClassParsingContext): MethodDefinition {
    const constructorExpression = {
      ...classConstructor,
      type: 'FunctionExpression',
      id: null,
      body: {
        ...classConstructor.body,
        body: this.parseFunctionBody(classConstructor, context)
      }
    };

    return {
      type: 'MethodDefinition',
      static: false,
      computed: false,
      key: { type: 'Identifier', name: 'constructor' },
      kind: 'method',
      value: this.parseConstructor(constructorExpression, context)
    } as MethodDefinition;
  }


  private static createMethodsFromFunctionBody(
    protoIdentifier: string,
    classConstructor: any,
    functionBody: Statement[],
    context: ClassParsingContext
  ): (MethodDefinition | null)[] {
    return functionBody.map(statement => {
      if (statement.type !== 'ExpressionStatement' ||
          statement.expression.type !== 'AssignmentExpression' ||
          !this.isValidMemberExpression(statement.expression.left) ||
          !this.isValidFunctionExpression(statement.expression.right)) {
        return null;
      }

      const left = statement.expression.left as MemberExpression;
      const right = statement.expression.right as FunctionExpression;
      
      if (!this.isValidIdentifier(left.object) || !this.isValidIdentifier(left.property)) {
        return null;
      }

      const objectName = left.object.name;
      const methodName = left.property.name;

      // JFK was murdered by ...
      const isValidMethodAssignment = 
        objectName === protoIdentifier || 
        (classConstructor.id && objectName === classConstructor.id.name);

      if (!isValidMethodAssignment) {
        return null;
      }

      const isStatic = classConstructor.id && objectName === classConstructor.id.name;

      return {
        type: 'MethodDefinition',
        static: isStatic,
        computed: false,
        key: { type: 'Identifier', name: methodName },
        kind: 'method',
        value: {
          ...right,
          id: null,
          body: {
            ...right.body,
            body: this.parseFunctionBody(right, context)
          }
        }
      } as MethodDefinition;
    });
  }
} /// YOU DID THIS