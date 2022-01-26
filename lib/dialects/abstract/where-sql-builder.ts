import assert from 'assert';
import nodeUtil from 'util';
import isPlainObject from 'lodash/isPlainObject';
import type { ModelStatic, WhereOperators, WhereOptions, WhereAttributeHash, ModelAttributeMeta } from '../../..';
import { DataTypes, Utils } from '../../..';
import { Op } from '../../operators';

const EMPTY_OBJECT = Object.freeze(Object.create(null));

// TODO (@ephys): remove once https://github.com/sequelize/sequelize/pull/14018 has been merged
//  but add "string" in parent typing
type WhereLeftOperand = Utils.Fn | Utils.Col | Utils.Literal | ModelAttributeMeta | string;

type LeftOperand = Utils.Fn | Utils.Col | Utils.Literal | string;

type Options = {
  model: ModelStatic<any>,
  prefix: string,
  type: unknown,
};

type Field = ModelAttributeMeta;

function isModelAttributeMeta(val: any): val is ModelAttributeMeta {
  return 'type' in val && 'fieldName' in val && val.type instanceof DataTypes.ABSTRACT;
}

class WhereSqlBuilder {
  constructor(private readonly queryGenerator: any) {}

  /**
   * Transforms any value accepted by {@link WhereOptions} into a SQL string.
   *
   * @param where
   * @param options
   */
  whereOptionsToSql(where: WhereOptions, options: Options): string {
    if (where == null) {
      // NO OP
      return '';
    }

    if (where instanceof Utils.Where) {
      return this.whereInstanceToSql(where, options);
    }

    if (where instanceof Utils.Literal || where instanceof Utils.Fn) {
      return this.queryGenerator.handleSequelizeMethod(where);
    }

    if (isPlainObject(where)) {
      return this.whereAttributeHashToSql(where, options);
    }

    throw new TypeError('Received invalid value for `where` option');
  }

  /**
   * Transforms any value accepted by {@link WhereAttributeHash} into a SQL string.
   *
   * @param where
   * @param options
   */
  whereAttributeHashToSql(where: WhereAttributeHash, options: Options): string {
    // @ts-expect-error - missing typings
    if (Utils.getComplexSize(where) === 0) {
      // NO OP
      return '';
    }

    return this.buildComparison(undefined, undefined, Op.and, where, options);
  }

  /**
   * Transforms an instance of {@link Utils.Where} (obtained from {@link Sequelize.where}) into a SQL string.
   *
   * @param where
   * @param options
   */
  whereInstanceToSql(where: Utils.Where, options: Options): string {
    // TODO (@ephys): Once Util has been migrated to TS
    //  rename Utils.Where fields
    //  attribute -> leftOperand
    //  comparator -> operator
    //  logic -> rightOperand

    const key = where.attribute as WhereLeftOperand;

    return this.buildComparison(
      isModelAttributeMeta(key) ? key.fieldName : key,
      isModelAttributeMeta(key) ? key : undefined,
      // TODO (@ephys): fix where.comparator once https://github.com/sequelize/sequelize/pull/14018 has been merged
      // @ts-expect-error
      where.comparator as keyof WhereOperators,
      where.logic,
      options,
    );
  }

  buildComparison<Operator extends keyof WhereOperators>(
    leftOperand: LeftOperand | undefined,
    leftOperandAttr: Field | undefined,
    operator: Operator,
    rightOperand: WhereOperators[Operator],
    options: Options = EMPTY_OBJECT,
  ): string {
    if (!(operator in this)) {
      return this.#buildSimpleOperator(leftOperand, leftOperandAttr, operator, rightOperand, options);
      // throw new Error(`${this.constructor.name}#[${String(operator)}] has not been implemented.`);
    }

    // @ts-expect-error
    return this[operator](leftOperand, leftOperandAttr, rightOperand, options);
  }

  #buildSimpleOperator<Operator extends keyof WhereOperators>(
    leftOperand: LeftOperand | undefined,
    leftOperandAttr: Field | undefined,
    operatorSymbol: Operator,
    rightOperand: WhereOperators[Operator],
    options: Options,
  ): string {
    const operator = this.queryGenerator.OperatorMap[operatorSymbol];
    if (!operator) {
      throw new Error(`Operator ${operator} is not supported in this dialect.`);
    }

    assert(leftOperand != null, 'key must be provided');

    const escapeOptions = {
      // iLike, like, notILike, notLike
      acceptStrings: operator.includes(this.queryGenerator.OperatorMap[Op.like]),
    };

    return this.queryGenerator._joinKeyValue(
      leftOperand,
      this.queryGenerator.escape(rightOperand, leftOperandAttr, escapeOptions),
      operator,
      options.prefix,
    );
  }

  [Op.eq](key: LeftOperand | undefined, field: Field, value: WhereOperators[typeof Op.eq], options: Options): string {
    // alias "= NULL" to "IS NULL"
    if (value === null) {
      return this.#buildSimpleOperator(key, field, Op.is, value, options);
    }

    // 'eq' is a bit of a special case. It is both used as comparison (=),
    // and as the default 'do nothing' operator in Sequelize.where()
    // @ts-expect-error - getOperators has no typings yet
    if (isPlainObject(value) && Utils.getOperators(value).length > 0) {
      return this.queryGenerator.whereItemQuery(key, value, options);
    }

    return this.#buildSimpleOperator(key, field, Op.eq, value, options);
  }

  [Op.ne](key: LeftOperand | undefined, field: Field, value: WhereOperators[typeof Op.eq], options: Options): string {
    // alias "!= NULL" to "IS NOT NULL"
    if (value === null) {
      return this.#buildSimpleOperator(key, field, Op.isNot, value, options);
    }

    return this.#buildSimpleOperator(key, field, Op.eq, value, options);
  }

  [Op.not](key: LeftOperand | undefined, field: Field, value: WhereOperators[typeof Op.not], options: Options): string {
    // Legacy: `{ [Op.not]: null }` used to mean "IS NOT NULL", which is now the role of `{ [Op.isNot]: null }`
    if (value === null) {
      return this.#buildSimpleOperator(key, field, Op.isNot, value, options);
    }

    // TODO (@ephys): check NOT support for different dialects
    const notOperator: string = this.queryGenerator.OperatorMap[Op.not];

    return `${notOperator} (${this.queryGenerator.whereItemQuery(key, value, options)})`;
  }

  [Op.and](key: LeftOperand | undefined, field: Field, value: WhereOperators[typeof Op.and], options: Options): string {
    return this.#andOr(key, field, value, options, Op.and);
  }

  [Op.or](key: LeftOperand | undefined, field: Field, value: WhereOperators[typeof Op.or], options: Options): string {
    return this.#andOr(key, field, value, options, Op.or);
  }

  #andOr(
    key: LeftOperand | undefined,
    field: Field,
    valueCollection: WhereOperators[typeof Op.or],
    options: Options,
    operatorSymbol: typeof Op.or | typeof Op.and,
  ) {
    const operator: string = this.queryGenerator.OperatorMap[operatorSymbol];

    if (Array.isArray(valueCollection)) {
      // Sequelize.or([
      //   { /* group1 */ },
      //   { /* group2 */ },
      // ])
      // -> (group1) OR (group2)
      return valueCollection.map(part => this.whereOptionsToSql(part, options))
        .join(operator);
    } else if (isPlainObject(valueCollection)) {
      // Sequelize.or({
      //   /* value 1 */,
      //   /* value 2 */,
      // })
      // -> (value1) OR (value2)

      // @ts-expect-error - typings not yet added
      return Utils.getComplexKeys(valueCollection)
        .map((attributeOrOperator: string | symbol) => {
          // TODO (@ephys): FIX ME - once Utils has been migrated to TS, add a isPlainObject that tells TS this is an object.
          // @ts-expect-error
          const value = valueCollection[attributeOrOperator];

          if (typeof attributeOrOperator === 'symbol') {
            return this.buildComparison(key, field, attributeOrOperator as keyof WhereOperators, value, options);
          }

          const newKey = attributeOrOperator;
          const newField = this.queryGenerator._findField(key, options);

          return this.buildComparison(newKey, newField, Op.eq, value, options);
        })
        .join(operator);
    }

    throw new TypeError(`Unsupported value used in with Operator ${String(operatorSymbol)}.\nExpected a POJO or an Array. Got ${nodeUtil.inspect(valueCollection)}`);
  }

  [Op.between](key: LeftOperand | undefined, field: Field,
    value: WhereOperators[typeof Op.between], options: Options): string {

    return this.#between(key, field, value, options, Op.between);
  }

  [Op.notBetween](key: LeftOperand | undefined, field: Field,
    value: WhereOperators[typeof Op.notBetween], options: Options): string {

    return this.#between(key, field, value, options, Op.notBetween);
  }

  /**
   * Common implementation for Op.notBetween and Op.between
   *
   * @param key
   * @param field
   * @param value
   * @param options
   * @param operatorSymbol
   */
  #between(
    key: LeftOperand | undefined,
    field: Field,
    value: WhereOperators[typeof Op.notBetween],
    options: Options,
    operatorSymbol: typeof Op.notBetween | typeof Op.between,
  ) {
    let rightOperand: string;

    if (value instanceof Utils.Literal) {
      rightOperand = this.queryGenerator.escape(value);
    } else if (Array.isArray(value) && value.length === 2) {
      rightOperand = `${this.queryGenerator.escape(value[0], field)} AND ${this.queryGenerator.escape(value[1], field)}`;
    } else {
      throw new TypeError('Op.between / Op.notBetween expect an array of length 2 or Sequelize.literal()');
    }

    const operator: string = this.queryGenerator.OperatorMap[operatorSymbol];

    return this.queryGenerator._joinKeyValue(
      key,
      rightOperand,
      operator,
      options.prefix,
    );
  }
}

export { WhereSqlBuilder };
