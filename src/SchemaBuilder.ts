import {FieldOptions} from './Mapping';
import * as Knex from 'knex';
import {Scope} from './Scope';
import {Store} from './Store';

export class SchemaBuilder {

  /**
   * @type {Scope}
   */
  private entityManager: Scope;

  /**
   * @type {Array}
   */
  private builders: Array<Knex.SchemaBuilder> = [];

  /**
   * @type {{}}
   */
  private types = {
    integer    : field => `.integer('${field.name}')`,
    bigInteger : field => `.bigInteger('${field.name}')`,
    text       : field => `.text('${field.name}', '${field.textType || 'text'}')`,
    string     : field => `.string('${field.name}', ${field.size || 255})`,
    float      : field => `.float('${field.name}', ${field.precision || 8}, ${field.scale || 2})`,
    decimal    : field => `.decimal('${field.name}', ${field.precision || 8}, ${field.scale || 2})`,
    boolean    : field => `.boolean('${field.name}')`,
    date       : field => `.date('${field.name}')`,
    dateTime   : field => `.dateTime('${field.name}')`,
    datetime   : field => `.datetime('${field.name}')`,
    time       : field => `.time('${field.name}')`,
    timestamp  : field => `.timestamp('${field.name}')`,
    binary     : field => `.binary('${field.name}')`,
    json       : field => `.json('${field.name}')`,
    jsonb      : field => `.jsonb('${field.name}')`,
    uuid       : field => `.uuid('${field.name}')`,
    enumeration: field => `.enu('${field.name}', ${JSON.stringify(field.enumeration).replace(/"/g, "'")})`,
  };

  /**
   * @type {string}
   */
  private code: string;

  /**
   * @type {string}
   */
  private sql: string;

  /**
   * @type {boolean}
   */
  private useForeignKeysGlobal: boolean;

  /**
   * @param {Scope} entityManager
   */
  public constructor(entityManager: Scope) {
    this.entityManager = entityManager;
  }

  /**
   * Returns if foreign keys should be used.
   *
   * @param {string} store
   *
   * @returns {boolean}
   */
  private useForeignKeys(store: string): boolean {
    let manager = this.entityManager;

    if (!this.useForeignKeysGlobal) {
      this.useForeignKeysGlobal = manager.getConfig().fetch('useForeignKeys');
    }

    return this.useForeignKeysGlobal && manager.getStore(store).getClient() !== 'sqlite3';
  }

  /**
   * Get the schema queries.
   *
   * @returns {string}
   */
  public getSQL(): string {
    if (this.sql) {
      return this.sql;
    }

    if (!this.builders.length) {
      this.runCode();
    }

    let queries = [];

    this.builders.forEach(builder => {
      let query = builder.toString();

      if (query) {
        queries.push(query);
      }
    });

    return this.sql = queries.join('\n');
  }

  /**
   * Get the built code.
   *
   * @returns {string}
   */
  public getCode(): string {
    return this.code;
  }

  /**
   * Run the built code.
   *
   * @returns {SchemaBuilder}
   */
  private runCode(): this {
    let migration = {
      getBuilder: store => {
        let connection    = this.entityManager.getStore(store).getConnection(Store.ROLE_MASTER);
        let schemaBuilder = connection.schema;

        this.builders.push(schemaBuilder);

        return {schema: schemaBuilder, knex: connection};
      }
    };

    // Come at me, bro.
    eval(this.code);

    return this;
  }

  /**
   * Persist the schema to the database.
   *
   * @returns {Promise<any[]>}
   */
  public apply(): Promise<any> {
    if (!this.builders.length) {
      this.runCode();
    }

    let queries = [];

    this.builders.forEach(query => {
      queries.push(query.then());
    });

    return Promise.all(queries);
  }

  /**
   * Process instructions.
   *
   * @param {{}} instructionSets
   *
   * @returns {SchemaBuilder}
   */
  public process(instructionSets): this {
    let spaceCount = 4;
    let allCode    = [];
    let spacing    = (change = 0): string => {
      spaceCount += change;

      return ' '.repeat(spaceCount - change);
    };

    Reflect.ownKeys(instructionSets).forEach((store: string) => {
      let useForeignKeys = this.useForeignKeys(store);
      let instructions   = instructionSets[store];
      let code           = [];

      // Rename tables
      if (Array.isArray(instructions.rename) && instructions.rename.length) {
        instructions.rename.forEach(rename => {
          code.push(`${spacing()}builder.schema.renameTable('${rename.from}', '${rename.to}');`);
        });

        code.push('');
      }

      this.buildTable(useForeignKeys, 'alter', false, instructions, code, spacing);
      this.buildTable(useForeignKeys, 'create', true, instructions, code, spacing);

      instructions.alter.forEach(alterData => {
        let tableName = alterData.tableName;

        if (useForeignKeys && alterData.info.foreign && alterData.info.foreign.length) {
          let mockInstructions = {alter: [{tableName, info: {foreign: alterData.info.foreign}}]};

          this.buildTable(useForeignKeys, 'alter', true, mockInstructions, code, spacing);
        }
      });

      // Drop tables
      instructions.drop.forEach(drop => {
        code.push(`\n${spacing()}builder.schema.dropTable('${drop}');`);
      });

      if (code.length) {
        allCode.push(`${spacing()}let builder = migration.getBuilder(${`'${store}'` || ''});`);

        allCode = allCode.concat(code);
      }
    });

    this.code     = allCode.length ? allCode.join('\n') : null;
    this.builders = [];

    return this;
  }

  /**
   * Build table.
   *
   * @param {boolean}   useForeign
   * @param {string}    action
   * @param {boolean}   createForeign
   * @param {{}}        instructions
   * @param {string[]}  code
   * @param {function}  spacing
   */
  private buildTable(useForeign: boolean,
                     action: string,
                     createForeign: boolean,
                     instructions: any,
                     code: Array<string>,
                     spacing: (change?: number)=>string) {
    instructions[action].forEach(actionData => {
      let tableName      = actionData.tableName;
      let table          = actionData.info;
      let hasDropForeign = Array.isArray(table.dropForeign) && table.dropForeign.length;
      let hasDropColumns = Array.isArray(table.dropColumn) && table.dropColumn.length;
      let pushedBuilder  = false;
      let ensureBuilder  = () => {
        if (pushedBuilder) {
          return;
        }

        code.push(`\n${spacing()}builder.schema.${action}Table('${tableName}', table => {`);
        spacing(2);

        pushedBuilder = true;
      };

      if (hasDropForeign || hasDropColumns) {
        code.push(`\n${spacing()}builder.schema.${action}Table('${tableName}', table => {`);
        spacing(2);

        // Drop foreign
        if (useForeign && hasDropForeign) {
          table.dropForeign.forEach(dropForeign => {
            code.push(`${spacing()}table.dropForeign('${dropForeign}');`);
          });
        }

        // Drop columns
        if (hasDropColumns) {
          table.dropColumn.forEach(column => {
            code.push(`${spacing()}table.dropColumn('${column}');`);
          });
        }

        spacing(-2);
        code.push(`${spacing()}});`);
      }

      // Column
      if (Array.isArray(table.fields) && table.fields.length) {
        ensureBuilder();

        table.fields.forEach(column => {
          code.push(spacing() + this.composeField(column));
        });
      }

      // Alter column
      if (Array.isArray(table.alterFields) && table.alterFields.length) {
        ensureBuilder();

        table.alterFields.forEach(column => {
          code.push(spacing() + this.composeField(column, true));
        });
      }

      // Drop index
      if (Array.isArray(table.dropIndex) && table.dropIndex.length) {
        ensureBuilder();

        table.dropIndex.forEach(dropIndex => {
          code.push(`${spacing()}table.dropIndex([], '${dropIndex.index}');`);
        });
      }

      // Drop unique
      if (Array.isArray(table.dropUnique) && table.dropUnique.length) {
        ensureBuilder();

        table.dropUnique.forEach(dropUnique => {
          code.push(`${spacing()}table.dropUnique([], '${dropUnique.unique}');`);
        });
      }

      // Add index
      if (typeof table.index === 'object') {
        Reflect.ownKeys(table.index).forEach(index => {
          ensureBuilder();

          code.push(`${spacing()}table.index(${JSON.stringify(table.index[index]).replace(/"/g, "'")}, '${index}');`);
        });
      }

      // Add unique
      if (typeof table.unique === 'object') {
        Reflect.ownKeys(table.unique).forEach(uniqueConstraint => {
          ensureBuilder();

          code.push(`${spacing()}table.unique(${JSON.stringify(table.unique[uniqueConstraint]).replace(/"/g, "'")}, '${uniqueConstraint}');`);
        });
      }

      if (useForeign && createForeign && table.foreign && table.foreign.length) {
        ensureBuilder();

        this.createForeign(table, spacing, code);
      }

      if (pushedBuilder) {
        spacing(-2);
        code.push(`${spacing()}});`);
      }
    });
  }

  /**
   * Create a foreign key.
   *
   * @param {{}}       table
   * @param {function} spacing
   * @param {string[]} code
   */
  private createForeign(table: {foreign: Array<any>}, spacing: (change?: number) => string, code: Array<string>): void {
    table.foreign.forEach(foreign => {
      let foreignCode = spacing();
      foreignCode += `table.foreign(${JSON.stringify(foreign.columns).replace(/"/g, "'")})`;
      foreignCode += `.references('${foreign.references}').inTable('${foreign.inTable}')`;

      if (foreign.onDelete) {
        foreignCode += `.onDelete('${foreign.onDelete}')`;
      }

      if (foreign.onUpdate) {
        foreignCode += `.onUpdate('${foreign.onUpdate}')`;
      }

      foreignCode += ';';

      code.push(foreignCode);
    });
  }

  /**
   * Compose a field.
   *
   * @param {FieldOptions} field
   * @param {boolean}      alter
   */
  private composeField(field: FieldOptions, alter: boolean = false) {
    let code = 'table';

    if (field.generatedValue) {
      if (field.generatedValue === 'autoIncrement') {
        code += `.increments('${field.name}')`;
      } else {
        throw new Error(`Unknown strategy '${field.generatedValue}' supplied for generatedValue.`);
      }
    }

    if (code === 'table') {
      if (!field.type) {
        return code + (alter ? '.alter()' : '') + ';';
      }

      if (!this.types[field.type]) {
        throw new Error(`Unknown field type '${field.type}' supplied.`);
      }

      code += this.types[field.type](field);
    }

    if (field.unsigned) {
      code += `.unsigned()`;
    }

    if (field.comment) {
      code += `.comment('${field.comment}')`;
    }

    if (field.nullable) {
      code += `.nullable()`;
    } else {
      code += `.notNullable()`;
    }

    if (field.primary) {
      code += `.primary()`;
    }

    if (typeof field.defaultTo !== 'undefined') {
      if (typeof field.defaultTo === 'object' && field.defaultTo.__raw) {
        code += `.defaultTo(builder.knex.raw('${field.defaultTo.__raw}'))`;
      } else {
        code += `.defaultTo('${field.defaultTo}')`;
      }
    }

    return code + (alter ? '.alter()' : '') + ';';
  }
}
