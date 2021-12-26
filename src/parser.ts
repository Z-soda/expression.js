import {TokenStream, TokenType} from "./token";
import {SyntaxError} from "./errors";
import ArrayExpression from "./ast/expr/array";
import LiteralExpression from "./ast/expr/literal";
import AssignStatement from "./ast/stmt/assign";
import MapExpression from "./ast/expr/map";
import BinaryExpression from "./ast/expr/binary";
import ExpressionStatement from "./ast/stmt/expr";
import BlockStatement from "./ast/stmt/block";
import VariableExpression from "./ast/expr/variable";
import MemberExpression from "./ast/expr/member";
import CallExpression from "./ast/expr/call";
import UpdateExpression from "./ast/expr/update";
import UnaryExpression from "./ast/expr/unary";
import {Expr, Stmt, Identifier} from "./ast/node";

export default class Parser{

    tokens: TokenStream;

    constructor(tokens: TokenStream) {
        this.tokens = tokens;
    }

    parse(): BlockStatement{
        const token = this.tokens.current();
        const stmts = [];
        while (!this.tokens.eof()) {
            stmts.push(this.parseStatement());
        }
        return new BlockStatement(stmts, token.position);
    }

    parseStatement(): Stmt{
        const token = this.tokens.current();
        let stmt;
        if (token.test(TokenType.T_ID) && this.tokens.look().test(TokenType.T_ASSIGN)) {
            stmt = this.parseAssignStatement();
        } else if (token.test(TokenType.T_LBRACE) && !this.tokens.look().test(TokenType.T_RBRACE) && !this.tokens.look(2).test(TokenType.T_COLON)) {
            stmt = this.parseBlockStatement();
        } else {
            stmt = new ExpressionStatement(this.parseExpression(), token.position);
        }
        if (!this.tokens.current().test(TokenType.T_EOF)) {
            this.tokens.expect(TokenType.T_SEMICOLON);
        }
        return stmt;
    }

    parseBlockStatement(): BlockStatement{
        this.tokens.expect(TokenType.T_LBRACE, 'A block must begin with an opening braces');
        const token = this.tokens.current();
        const stmts = [];
        while (!this.tokens.current().test(TokenType.T_RBRACE)) {
            stmts.push(this.parseStatement());
        }
        this.tokens.expect(TokenType.T_RBRACE, 'A block must be closed by a braces');
        return new BlockStatement(stmts, token.position);
    }

    parseAssignStatement(): AssignStatement{
        const token = this.tokens.current();
        const variable = new Identifier(token.value, token.position);
        return new AssignStatement(variable, this.parseExpression(), token.position);
    }

    parseExpression(): Expr{
        let expr = this.parsePrimaryExpression();
        if (this.tokens.current().isBinaryOperator()) {
            expr = this.parseBinaryExpression(expr);
        }
        return expr;
    }

    parsePrimaryExpression(): Expr{
        const token = this.tokens.current();
        let expr;
        switch (token.type) {
            // constant
            case TokenType.T_STR:
                expr = new LiteralExpression(token.value, token.value, token.position);
                this.tokens.next();
                break;
            case TokenType.T_NUM:
                expr = new LiteralExpression(Number(token.value), token.value, token.position);
                this.tokens.next();
                break;
            // identifier
            case TokenType.T_ID:
                expr = this.parseIdentifierExpression();
                break;
            // punctuation
            case TokenType.T_LBRACKET:
                expr = this.parseArrayExpression();
                break;
            case TokenType.T_LBRACE:
                expr = this.parseMapExpression();
                break;
            case TokenType.T_LPAREN:
                expr = this.parseParenExpression();
                break;
            // unary operator
            case TokenType.T_INC:
            case TokenType.T_DEC:
                expr = this.parseUpdateExpression(true);
                break;
            case TokenType.T_NOT:
            case TokenType.T_ADD:
            case TokenType.T_SUB:
                expr = this.parseUnaryExpression();
                break;
            default:
                throw new SyntaxError(`Unexpected token "${token.type}" of value "${token.value}".`);
        }
        return this.parsePosixExpression(expr);
    }

    parsePosixExpression(expr: Expr): Expr{
        while (true) {
            const token = this.tokens.current();
            let end = false;
            switch (token.type) {
                case TokenType.T_LPAREN:
                    expr = new CallExpression(expr, this.parseArguments(), token.position);
                    break;
                case TokenType.T_DOT:
                    expr = this.parseObjectExpression(expr);
                    break;
                case TokenType.T_LBRACKET: // array[1] , map['property']
                    expr = this.parseAccessExpression(expr);
                     break;
                default:
                    if (this.tokens.current().testAny(TokenType.T_INC, TokenType.T_DEC)) {// unary operator
                        expr = this.parseUpdateExpression(false, expr);
                    } else {
                        end = true;
                    }
            }
            if (end) {
                break;
            }
        }
        return expr;
    }

    parseIdentifierExpression(): Expr{
        const token = this.tokens.current();
        let expr;
        switch (token.value) {
            case 'true':
            case 'TRUE':
                expr = new LiteralExpression(true, token.value, token.position);
                break;
            case 'false':
            case 'FALSE':
                expr = new LiteralExpression(false, token.value, token.position);
                break;
            case 'null':
            case 'NULL':
                expr = new LiteralExpression(null, token.value, token.position);
                break;
            default:
                expr = new VariableExpression(token.value, token.position);
        }
        this.tokens.next();
        return expr;
    }

    parseObjectExpression(object: Expr): Expr{
        this.tokens.expect(TokenType.T_DOT);
        const token = this.tokens.expect(TokenType.T_ID);
        const property = new Identifier(token.value, token.position);
        let expr: Expr = new MemberExpression(object, property, false, object.position)
        if (this.tokens.current().test(TokenType.T_LPAREN)) { // method
            expr = new CallExpression(expr, this.parseArguments(), object.position);
        }
        return expr;
    }

    parseAccessExpression(object: Expr): MemberExpression{
        this.tokens.expect(TokenType.T_LBRACKET);
        const property = this.parseExpression();
        this.tokens.expect(TokenType.T_RBRACKET);
        return new MemberExpression(object, property as Identifier, false, object.position)
    }

    parseBinaryExpression(expr: Expr): BinaryExpression{
        // a + b * c / d
        // a * b + c
        while (this.tokens.current().isBinaryOperator()) {
            expr = this.doParseBinary(expr);
        }
        return expr as BinaryExpression;
    }

    doParseBinary(left: Expr): BinaryExpression{
        const token = this.tokens.current();
        const operator = token.value;
        const currentPrecedence = token.getBinaryPrecedence().precedence;

        // right expr.
        this.tokens.next();
        let right = this.parsePrimaryExpression();
        const nextPrecedence = this.tokens.current().getBinaryPrecedence().precedence;
        if (currentPrecedence < nextPrecedence) {
            right = this.doParseBinary(right);
        }
        return new BinaryExpression(left, operator, right, left.position);
    }

    parseUnaryExpression(): UnaryExpression{
        // !+-+-+-!!+-10
        const token = this.tokens.current();
        const operator = token.value;
        this.tokens.next();
        const argument = this.parsePrimaryExpression();
        return new UnaryExpression(operator, argument, token.position);
    }

    parseUpdateExpression(prefix: boolean, argument ?: Expr): UpdateExpression{
        const token = this.tokens.expectOneOf(TokenType.T_INC, TokenType.T_DEC);
        if (prefix) {  // ++a ++a.b ++a.read()
            // ++ a + 1
            // a + b --
            argument = this.parsePrimaryExpression();
        } else {  // a ++  a.b ++ a.c() ++
        }
        if (!(argument instanceof VariableExpression) && !(argument instanceof MemberExpression)) {
            throw new SyntaxError('Invalid left-hand side in assignment');
        }
        return new UpdateExpression(token.value, argument, prefix, prefix ? token.position : argument.position)
    }

    parseParenExpression(): Expr{
        this.tokens.expect(TokenType.T_LPAREN);
        const expr = this.parseExpression();
        this.tokens.expect(TokenType.T_RPAREN);
        return expr;
    }

    parseArrayExpression(): ArrayExpression{
        const token = this.tokens.current();
        const expr = new ArrayExpression([], token.position);
        while (!this.tokens.current().test(TokenType.T_RBRACKET)) {
            if (!expr.isEmpty()) {
                this.tokens.expect(TokenType.T_COMMA, 'An array element must be followed by a comma');
            }
            expr.addElement(this.parseExpression());
        }
        this.tokens.expect(TokenType.T_RBRACKET, 'An array element must be closed by a brackets');
        return expr;
    }

    parseMapExpression(): MapExpression{
        const token = this.tokens.current();
        this.tokens.expect(TokenType.T_LBRACE, 'A map must begin with an opening braces');
        const expr = new MapExpression([], token.position);
        while (!this.tokens.current().test(TokenType.T_RBRACE)) {
            if (!expr.isEmpty()) {
                this.tokens.expect(TokenType.T_COMMA, 'A map must be followed by a comma');
            }
            const key = this.tokens.expect(TokenType.T_STR, 'A map key must be a string');
            this.tokens.expect(TokenType.T_COLON, 'The map key and value must be separated by a colon(:)');
            const value = this.parseExpression();
            expr.addElement(new LiteralExpression(key.value, key.value, key.position), value);
        }
        this.tokens.expect(TokenType.T_RBRACE, 'A map must be closed by a braces');
        return expr;
    }

    parseArguments(): Expr[]{
        // the_foo_func(1, "foo")
        const args = [];
        this.tokens.expect(TokenType.T_LPAREN, 'A list of arguments must begin with an opening parenthesis');
        while (!this.tokens.current().test(TokenType.T_RPAREN)) {
            if (args.length > 0) { // the prev arguments is exists.
                this.tokens.expect(TokenType.T_COMMA, 'Arguments must be separated by a comma');
            }
            args.push(this.parseExpression());
        }
        this.tokens.expect(TokenType.T_RPAREN, 'A list of arguments must be closed by a parenthesis');
        return args;
    }
}